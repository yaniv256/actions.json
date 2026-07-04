(() => {
  const STORAGE_KEY = "actionsJson.storage.v1";
  const BOOKMARKLET_VERSION = "0.1.37";
  const BARE_SITE_FALLBACK_SCOPE = "private";
  const BRIDGE_URL = "ws://127.0.0.1:17345/extension";
  const BOOKMARKLET_RELAY_SOURCE = "ajbm";
  const EXTENSION_RELAY_SOURCE = "ajex";
  const ROOT_ID = "actions-json-storage-bookmarklet";
  const RUNTIME_ID = `actions-json-bookmarklet-${Math.random().toString(36).slice(2)}`;
  let storageDirectoryHandle = null;
  let lastFolderRead = null;
  let socket = null;
  let reconnectTimer = null;
  let bridgeConnected = false;
  let relayActive = false;
  let relayAnnounceTimer = null;
  let transportMode = "direct";
  let shouldReconnect = true;
  let collapsed = false;
  let preCollapseFrame = null;
  let suppressNextCollapseClick = false;
  const overlayTabs = new Map();
  const overlayRegistry = new Map();
  let launcherObserver = null;
  let launcherUrlPoller = null;
  let launcherRefreshTimer = null;
  let lastObservedHref = location.href;
  const DEFAULT_MIN_PRIMITIVE_INTERVAL_MS = 500;
  let minPrimitiveIntervalMs = DEFAULT_MIN_PRIMITIVE_INTERVAL_MS;
  let primitiveQueue = Promise.resolve();
  let lastHumanInteractionStartedAt = 0;
  const LAUNCHER_ATTR = "data-actions-json-overlay-launcher";
  const objectInputSchema = { type: "object" };

  const baseManifest = {
    tools: [
      {
        name: "overlay.open",
        input_schema: objectInputSchema,
      },
      {
        name: "overlay.register_launcher",
        input_schema: objectInputSchema,
      },
      {
        name: "overlay.close",
        input_schema: objectInputSchema,
      },
      {
        name: "storage.import_bundle",
        input_schema: objectInputSchema,
      },
      {
        name: "storage.list",
        input_schema: objectInputSchema,
      },
      {
        name: "runtime.configure_pacing",
        input_schema: objectInputSchema,
      },
      {
        name: "browser.run_javascript",
        input_schema: objectInputSchema,
      },
      {
        name: "browser.screenshot",
        input_schema: objectInputSchema,
      },
      {
        name: "locator.element_info",
        input_schema: objectInputSchema,
      },
      {
        name: "browser.extract_elements",
        input_schema: objectInputSchema,
      },
      {
        name: "dom.list_sections",
        input_schema: objectInputSchema,
      },
      {
        name: "pointer.move",
        input_schema: objectInputSchema,
      },
      {
        name: "pointer.click",
        input_schema: objectInputSchema,
      },
      {
        name: "pointer.double_click",
        input_schema: objectInputSchema,
      },
      {
        name: "pointer.drag",
        input_schema: objectInputSchema,
      },
      {
        name: "viewport.scroll",
        input_schema: objectInputSchema,
      },
      {
        name: "text.insert",
        input_schema: objectInputSchema,
      },
      {
        name: "keyboard.press",
        input_schema: objectInputSchema,
      },
      {
        name: "page.info",
        input_schema: objectInputSchema,
      },
      {
        name: "dom.observe.visible",
        input_schema: objectInputSchema,
      },
      {
        name: "dom.snapshot_text",
        input_schema: objectInputSchema,
      },
      {
        name: "locator.text_content",
        input_schema: objectInputSchema,
      },
      {
        name: "locator.wait_for",
        input_schema: objectInputSchema,
      },
    ],
  };
  const primitiveDictionaryMetadata = { version: 1, stage: 1, host: "embed", primitives: [["browser.screenshot","unsupported","capability_unavailable","privileged",false],["browser.claimed_tabs.list","unsupported","capability_unavailable","privileged",false],["browser.claimed_tabs.activate","unsupported","capability_unavailable","privileged",false],["browser.navigate","unsupported","capability_unavailable","privileged",false],["browser.open_tab","unsupported","capability_unavailable","privileged",false],["browser.close_tab","unsupported","capability_unavailable","privileged",false],["browser.dismiss_dialog","unsupported","capability_unavailable","privileged",false],["pointer.move","supported",null,"portable",true],["pointer.click","supported",null,"portable",true],["pointer.double_click","supported",null,"portable",true],["pointer.drag","supported",null,"portable",true],["viewport.scroll","supported",null,"portable",true],["storage.read_file","unsupported","capability_unavailable","privileged",false],["text.insert","supported",null,"portable",true],["keyboard.press","partial","trusted_key_events_unavailable","mixed",false],["transfer.insert","unsupported","capability_unavailable","privileged",false],["transfer.clear","unsupported","capability_unavailable","privileged",false],["transfer.read","unsupported","capability_unavailable","privileged",false],["transfer.write","unsupported","capability_unavailable","privileged",false],["clipboard.write","unsupported","capability_unavailable","privileged",false],["clipboard.read","unsupported","capability_unavailable","privileged",false],["runtime.session.name","unsupported","capability_unavailable","privileged",false],["runtime.session.finalize_tabs","unsupported","capability_unavailable","privileged",false],["page.info","supported",null,"portable",true],["dom.observe.visible","supported",null,"portable",true],["dom.snapshot_text","supported",null,"portable",true],["dom.list_sections","supported",null,"portable",true],["locator.element_info","supported",null,"portable",true],["locator.text_content","supported",null,"portable",true],["locator.wait_for","supported",null,"portable",true],["overlay.open","supported",null,"privileged",false],["overlay.register_launcher","supported",null,"privileged",false],["overlay.close","supported",null,"privileged",false]].map(([name, support, reason, capability_class, portable]) => ({ name, support, reason, capability_class, portable })) };

  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    window.__actionsJsonStorageBookmarkletRuntime?.disconnect?.();
    existing.remove();
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.position = "fixed";
  root.style.inset = "24px 24px auto auto";
  root.style.zIndex = "2147483647";
  document.documentElement.appendChild(root);

  const shadow = root.attachShadow({ mode: "open" });
  const shellCss = `
      :host {
        all: initial;
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel {
        width: min(440px, calc(100vw - 48px));
        min-width: 280px;
        min-height: 118px;
        max-height: min(620px, calc(100vh - 48px));
        overflow: hidden;
        resize: both;
        background: Canvas;
        color: CanvasText;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 8px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }
      .collapsed.panel {
        width: 32px;
        height: 32px;
        min-width: 32px;
        min-height: 32px;
        max-height: 32px;
        box-sizing: border-box;
        overflow: hidden;
        resize: none;
        background: transparent;
        color: #f9fafb;
        border: 0;
        border-radius: 6px;
        box-shadow: none;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
        cursor: move;
        user-select: none;
      }
      .collapsed header {
        width: 32px;
        height: 32px;
        box-sizing: border-box;
        justify-content: center;
        padding: 0;
        border-bottom: 0;
        position: relative;
      }
      h1 {
        margin: 0;
        font-size: 15px;
        line-height: 1.3;
        font-weight: 650;
      }
      button {
        font: inherit;
        font-size: 13px;
        border-radius: 6px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
        color: CanvasText;
      }
      button {
        cursor: pointer;
        padding: 8px 10px;
      }
      button.icon {
        width: 32px;
        height: 32px;
        padding: 0;
      }
      .window-controls {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
      }
      .collapsed main {
        display: none;
      }
      .collapsed [data-close] {
        display: none;
      }
      .collapsed .window-controls {
        gap: 0;
        position: absolute;
        inset: 0;
      }
      .collapsed [data-collapse] {
        display: grid;
        place-items: center;
        position: absolute;
        inset: 0;
        box-sizing: border-box;
        width: 32px;
        height: 32px;
        background: #1f2937;
        color: #f9fafb;
        border-color: rgba(255, 255, 255, 0.42);
        font-size: 17px;
        line-height: 1;
      }
      main {
        display: grid;
        grid-template-rows: minmax(0, 1fr);
        padding: 12px;
        min-height: 0;
        overflow: hidden;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .field {
        display: grid;
        gap: 6px;
      }
      .field span, .muted {
        color: color-mix(in srgb, CanvasText 64%, transparent);
        font-size: 12px;
        line-height: 1.4;
      }
      .tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: flex-start;
        min-height: 33px;
        flex: 1 1 auto;
        min-width: 0;
        background: Canvas;
      }
      .tab-button {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tab-button[aria-selected="true"] {
        background: #111827;
        color: #f9fafb;
        border-color: #111827;
      }
      .tab-panels {
        display: block;
        min-height: 0;
        border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
        border-radius: 8px;
        overflow: auto;
      }
      .tab-panel {
        display: none;
        padding: 12px;
      }
      .tab-panel.active {
        display: block;
      }
      .tab-panel img {
        max-width: 100%;
        height: auto;
      }
      .tab-frame {
        display: block;
        width: 100%;
        min-height: 560px;
        border: 0;
        border-radius: 6px;
        background: #fff;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        padding: 10px;
        border-radius: 6px;
        background: color-mix(in srgb, Canvas 90%, CanvasText 10%);
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        line-height: 1.45;
      }
  `;
  const style = document.createElement("style");
  style.textContent = shellCss;
  shadow.append(style, buildShell());

  const page = shadow.querySelector("[data-page]");
  const status = shadow.querySelector("[data-status]");
  const panel = shadow.querySelector(".panel");
  const collapseButton = shadow.querySelector("[data-collapse]");
  const tabs = shadow.querySelector("[data-tabs]");
  const tabPanels = shadow.querySelector("[data-tab-panels]");

  page.textContent = `${location.hostname}\n${location.href}`;
  registerExistingTab("actions-json", "actions.json");
  registerExistingTab("status", "Status");
  activateTab("actions-json");
  renderStatus();
  connect(BRIDGE_URL).catch(() => {});

  function buildShell() {
    const panelNode = createNode("section", {
      className: "panel",
      attrs: {
        role: "dialog",
        "aria-label": "actions.json bookmarklet",
      },
    });
    const header = createNode("header", { attrs: { "data-drag-handle": "" } });
    const tabsNode = createNode("div", {
      className: "tabs",
      attrs: {
        "data-tabs": "",
        "aria-label": "actions.json tabs",
      },
    });
    const controls = createNode("div", { className: "window-controls" }, [
      createNode("button", {
        className: "icon",
        text: "×",
        attrs: {
          "data-close": "",
          title: "Close and disconnect",
        },
      }),
      createNode("button", {
        className: "icon",
        text: "☰",
        attrs: {
          "data-collapse": "",
          title: "Collapse",
        },
      }),
    ]);
    const main = createNode("main");
    const panels = createNode("div", {
      className: "tab-panels",
      attrs: { "data-tab-panels": "" },
    });
    const actionsPanel = createNode("section", {
      className: "tab-panel",
      attrs: { "data-tab-id": "actions-json" },
    });
    const buttonRow = createNode("div", { className: "row" }, [
      createNode("button", { text: "Choose storage folder", attrs: { "data-choose-folder": "" } }),
      createNode("button", { text: "Load from folder", attrs: { "data-load-folder": "" } }),
      createNode("button", { text: "Write to folder", attrs: { "data-write-folder": "" } }),
      createNode("button", { text: "Clear local bundle", attrs: { "data-clear": "" } }),
    ]);
    const note = createNode("p", {
      className: "muted",
      text: "Chrome can read and write the chosen folder after explicit permission. Files for unrelated sites are ignored.",
    });
    const pageField = createNode("div", { className: "field" }, [
      createNode("span", { text: "Current page" }),
      createNode("pre", { attrs: { "data-page": "" } }),
    ]);
    const statusPanel = createNode("section", {
      className: "tab-panel",
      attrs: { "data-tab-id": "status" },
    }, [
      createNode("div", { className: "field" }, [
        createNode("span", { text: "Status" }),
        createNode("pre", { attrs: { "data-status": "" } }),
      ]),
    ]);
    actionsPanel.append(buttonRow, note, pageField);
    panels.append(actionsPanel, statusPanel);
    main.append(panels);
    header.append(tabsNode, controls);
    panelNode.append(header, main);
    return panelNode;
  }

  function createNode(tagName, options = {}, children = []) {
    const node = document.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    for (const [name, value] of Object.entries(options.attrs || {})) {
      node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  }

  shadow.querySelector("[data-close]").addEventListener("click", () => cleanupAndRemove());
  shadow.querySelector("[data-collapse]").addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressNextCollapseClick) {
      suppressNextCollapseClick = false;
      return;
    }
    toggleCollapsed();
  });
  collapseButton.addEventListener("pointerdown", (event) => {
    if (!collapsed) return;
    event.stopPropagation();
    startDrag(event, { suppressClickOnMove: true });
  });
  shadow.querySelector("[data-drag-handle]").addEventListener("pointerdown", startDrag);
  shadow.querySelector("[data-choose-folder]").addEventListener("click", async () => {
    try {
      if (!("showDirectoryPicker" in window)) {
        renderStatus("Folder access is not supported in this browser.");
        return;
      }
      storageDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      renderStatus(`Selected folder: ${storageDirectoryHandle.name}`);
    } catch (error) {
      renderStatus(`Folder selection failed: ${error.message}`);
    }
  });
  shadow.querySelector("[data-load-folder]").addEventListener("click", async () => {
    try {
      const handle = await requireStorageDirectoryHandle();
      const result = await readRelevantDirectoryEntries(handle, {
        currentUrl: location.href,
        defaultScope: BARE_SITE_FALLBACK_SCOPE,
      });
      lastFolderRead = result.diagnostics;
      const entries = result.entries;
      const bundle = buildRelevantStorageBundle(entries, {
        currentUrl: location.href,
        defaultScope: BARE_SITE_FALLBACK_SCOPE,
      });
      console.info("[actions.json.storage] folder load diagnostics", {
        diagnostics: lastFolderRead,
        bundle,
      });
      if (bundle.fileCount === 0) {
        renderStatus(
          `No files matched ${location.hostname}.\nRead: ${entries.length}\nRejected: ${bundle.rejected.length}`,
        );
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle));
      announceRuntimeReady();
      renderStatus(`Loaded ${bundle.fileCount} file(s) from ${handle.name}.\nRejected ${bundle.rejected.length} unrelated file(s).`);
    } catch (error) {
      renderStatus(`Load from folder failed: ${error.message}`);
    }
  });
  shadow.querySelector("[data-write-folder]").addEventListener("click", async () => {
    try {
      const handle = await requireStorageDirectoryHandle();
      const bundle = loadBundle();
      if (!bundle) {
        renderStatus("No local bundle to write.");
        return;
      }
      const targets = writeTargetsForBundle(bundle);
      if (targets.length === 0) {
        renderStatus("Local bundle has no write targets.");
        return;
      }
      renderStatus(`Writing ${targets.length} file(s) to ${handle.name}...`);
      const selectedSitePrefix = selectedSiteFolderPrefix(handle.name, location.href, BARE_SITE_FALLBACK_SCOPE);
      const written = [];
      for (const target of targets) {
        await writeTextAtPath(handle, writePartsForSelectedFolder(target, selectedSitePrefix), target.text);
        written.push(target.path);
      }
      console.info("[actions.json.storage] folder write complete", { folder: handle.name, written });
      renderStatus(
        `Wrote ${written.length} file(s) to ${handle.name}.\nReview with git diff before committing.\n\n${written
          .sort()
          .join("\n")}`,
      );
    } catch (error) {
      renderStatus(`Write to folder failed: ${error.message}`);
    }
  });
  shadow.querySelector("[data-clear]").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    announceRuntimeReady();
    renderStatus("Cleared local bundle.");
  });

  window.__actionsJsonStorageBookmarkletRuntime = {
    disconnect() {
      shouldReconnect = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "bookmarklet closed");
      }
      socket = null;
      bridgeConnected = false;
      stopRelayAnnouncement();
      stopLauncherObservers();
    },
    openTab,
    installLaunchers,
  };

  window.addEventListener("beforeunload", () => {
    window.__actionsJsonStorageBookmarkletRuntime?.disconnect?.();
  });

  function cleanupAndRemove() {
    window.__actionsJsonStorageBookmarkletRuntime?.disconnect?.();
    root.remove();
  }

  function toggleCollapsed() {
    const shouldCollapse = !collapsed;
    const buttonRect = shouldCollapse ? collapseButton.getBoundingClientRect() : null;
    collapsed = !collapsed;
    panel.classList.toggle("collapsed", collapsed);
    collapseButton.textContent = collapsed ? "☰" : "☰";
    collapseButton.title = collapsed ? "Expand" : "Collapse";
    if (collapsed) {
      preCollapseFrame = {
        left: root.style.left,
        top: root.style.top,
        right: root.style.right,
        bottom: root.style.bottom,
        inset: root.style.inset,
        width: panel.style.width,
        height: panel.style.height,
      };
      root.style.inset = "auto auto auto auto";
      root.style.left = `${buttonRect.left}px`;
      root.style.top = `${buttonRect.top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
      panel.style.width = "32px";
      panel.style.height = "32px";
    } else if (preCollapseFrame) {
      root.style.inset = preCollapseFrame.inset;
      root.style.left = preCollapseFrame.left;
      root.style.top = preCollapseFrame.top;
      root.style.right = preCollapseFrame.right;
      root.style.bottom = preCollapseFrame.bottom;
      panel.style.width = preCollapseFrame.width;
      panel.style.height = preCollapseFrame.height;
      preCollapseFrame = null;
    }
  }

  function openTab(tab) {
    if (!tab || typeof tab !== "object") {
      throw new Error("actionsJson.openTab requires a tab object");
    }
    const id = tab.id || slugFor(tab.title || "overlay");
    const title = tab.title || id;
    const existing = overlayTabs.get(id);
    const button = existing?.button || document.createElement("button");
    const panelElement = existing?.panelElement || document.createElement("section");
    const resolvedTab = resolveOverlayTab(tab);
    const parsedContent = resolvedTab.templateDriven ? null : parseOverlayHtml(resolvedTab.html || resolvedTab.body || "");

    button.type = "button";
    button.className = "tab-button";
    button.textContent = title;
    button.dataset.tabId = id;

    panelElement.className = "tab-panel";
    panelElement.dataset.tabId = id;
    clearTabBlobUrl(panelElement);
    panelElement.replaceChildren();
    if (resolvedTab.templateDriven) {
      const frame = document.createElement("iframe");
      frame.className = "tab-frame";
      frame.title = title;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = buildTemplateDocumentHtml({
        html: resolvedTab.html,
        data: resolvedTab.dataValue,
      });
      panelElement.appendChild(frame);
      setTabStyles(id, []);
    } else {
      const content = document.createElement("div");
      content.className = "tab-content";
      content.innerHTML = parsedContent.bodyHtml;
      panelElement.appendChild(content);
      setTabStyles(id, parsedContent.styles);
    }

    if (!existing) {
      button.addEventListener("click", () => activateTab(id));
      tabs.appendChild(button);
      tabPanels.appendChild(panelElement);
    }

    overlayTabs.set(id, { button, panelElement, title });
    activateTab(id);
    if (collapsed) toggleCollapsed();
    renderStatus(`Opened tab: ${title}`);
    return {
      ok: true,
      tab_id: id,
      template: resolvedTab.templateDriven ? resolvedTab.template : null,
      data: resolvedTab.templateDriven ? (resolvedTab.data || null) : null,
    };
  }

  function registerExistingTab(id, title) {
    const existing = overlayTabs.get(id);
    if (existing) return existing;
    const button = document.createElement("button");
    const panelElement = tabPanels.querySelector(`[data-tab-id="${cssEscape(id)}"]`);
    if (!panelElement) {
      throw new Error(`Missing tab panel: ${id}`);
    }
    button.type = "button";
    button.className = "tab-button";
    button.textContent = title;
    button.dataset.tabId = id;
    button.addEventListener("click", () => activateTab(id));
    tabs.appendChild(button);
    const tab = { button, panelElement, title };
    overlayTabs.set(id, tab);
    return tab;
  }

  function closeOverlayTabs() {
    for (const tab of overlayTabs.values()) {
      tab.button.remove();
      clearTabBlobUrl(tab.panelElement);
      tab.panelElement.remove();
    }
    overlayTabs.clear();
    for (const style of shadow.querySelectorAll("style[data-actions-json-tab-style]")) {
      style.remove();
    }
    renderStatus("Closed overlay tabs.");
    return { ok: true };
  }

  function activateTab(id) {
    for (const [tabId, tab] of overlayTabs.entries()) {
      const selected = tabId === id;
      tab.button.setAttribute("aria-selected", selected ? "true" : "false");
      tab.panelElement.classList.toggle("active", selected);
    }
  }

  function installLaunchers(overlayArgs = {}) {
    const normalized = {
      ...overlayArgs,
      id: overlayArgs.id || overlayArgs.tab_id || slugFor(overlayArgs.title || "overlay"),
    };
    overlayRegistry.set(normalized.id, normalized);
    const installed = refreshRegisteredLaunchers();
    startLauncherObservers();
    return { ok: true, launchers: installed };
  }

  function refreshRegisteredLaunchers() {
    if (overlayRegistry.size === 0) return [];
    const installed = [];
    for (const overlayArgs of overlayRegistry.values()) {
      installed.push(...installLaunchersForOverlay(overlayArgs));
    }
    return installed;
  }

  function installLaunchersForOverlay(overlayArgs) {
    const configs = [
      ...(Array.isArray(overlayArgs.launchers) ? overlayArgs.launchers : []),
      ...(overlayArgs.launcher ? [overlayArgs.launcher] : []),
    ].filter(Boolean);
    const installed = [];
    for (const launcher of configs) {
      const launcherId = launcher.id || slugFor(overlayArgs.title || overlayArgs.id || "overlay");
      removeLauncherButtons(launcherId);
      if (!urlMatchesLauncher(launcher)) continue;
      for (const target of findLauncherTargets(launcher)) {
        const button = createLauncherButton(launcher, launcherId, overlayArgs);
        const placement = launcher.placement || "afterend";
        if (["beforebegin", "afterbegin", "beforeend", "afterend"].includes(placement)) {
          target.insertAdjacentElement(placement, button);
        } else {
          target.insertAdjacentElement("afterend", button);
        }
        installed.push({
          launcher_id: launcherId,
          placement,
          target_text: normalizeText(target.textContent || target.getAttribute("aria-label") || "").slice(0, 120),
        });
      }
    }
    return installed;
  }

  function createLauncherButton(launcher, launcherId, overlayArgs) {
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
      "white-space:nowrap",
    ].join(";");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTab(overlayArgs);
      emitDomEvent("actions-json:overlay-launcher-opened", { launcher_id: launcherId });
    });
    return button;
  }

  function findLauncherTargets(launcher) {
    const selectors = Array.isArray(launcher.selectors)
      ? launcher.selectors
      : launcher.selector
        ? [launcher.selector]
        : [];
    const candidates = [];
    for (const selector of selectors) {
      try {
        candidates.push(...document.querySelectorAll(selector));
      } catch (_error) {}
    }
    if (candidates.length === 0 && (launcher.text_contains || launcher.text_equals)) {
      candidates.push(...document.querySelectorAll("a,button,h1,h2,h3,h4,[role='heading'],span,div"));
    }
    const seen = new Set();
    return candidates
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        if (!isElementVisible(element)) return false;
        const text = normalizeText(element.textContent || element.getAttribute("aria-label") || "").toLowerCase();
        if (launcher.text_equals && text !== String(launcher.text_equals).toLowerCase()) return false;
        if (launcher.text_contains && !text.includes(String(launcher.text_contains).toLowerCase())) return false;
        return true;
      })
      .slice(0, Number(launcher.max_instances) || 3);
  }

  function removeLauncherButtons(launcherId) {
    document.querySelectorAll(`[${LAUNCHER_ATTR}]`).forEach((element) => {
      if (element.getAttribute(LAUNCHER_ATTR) === launcherId) element.remove();
    });
  }

  function urlMatchesLauncher(launcher) {
    if (launcher.url_contains && !location.href.includes(launcher.url_contains)) return false;
    if (launcher.url_matches) {
      try {
        return new RegExp(launcher.url_matches).test(location.href);
      } catch (_error) {
        return false;
      }
    }
    return true;
  }

  function startLauncherObservers() {
    if (launcherObserver || launcherUrlPoller) return;
    launcherObserver = new MutationObserver(() => scheduleLauncherRefresh());
    launcherObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleLauncherRefresh);
    window.addEventListener("hashchange", scheduleLauncherRefresh);
    launcherUrlPoller = setInterval(() => {
      if (location.href !== lastObservedHref) {
        lastObservedHref = location.href;
        scheduleLauncherRefresh();
      }
    }, 500);
  }

  function stopLauncherObservers() {
    launcherObserver?.disconnect();
    launcherObserver = null;
    if (launcherUrlPoller) clearInterval(launcherUrlPoller);
    launcherUrlPoller = null;
    clearTimeout(launcherRefreshTimer);
    launcherRefreshTimer = null;
    window.removeEventListener("popstate", scheduleLauncherRefresh);
    window.removeEventListener("hashchange", scheduleLauncherRefresh);
  }

  function scheduleLauncherRefresh() {
    if (overlayRegistry.size === 0) return;
    clearTimeout(launcherRefreshTimer);
    launcherRefreshTimer = setTimeout(() => refreshRegisteredLaunchers(), 180);
  }

  function emitDomEvent(name, payload) {
    protocolSend({
      type: "dom_event",
      event_id: `dom-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      event: name,
      name,
      runtime_id: RUNTIME_ID,
      url: location.href,
      observed_at: new Date().toISOString(),
      payload,
    });
  }

  function slugFor(value) {
    return String(value || "overlay").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "overlay";
  }

  function parseOverlayHtml(value) {
    const html = String(value || "");
    const documentLike = /<(?:!doctype|html|head|body|style)\b/i.test(html);
    if (!documentLike) {
      return { bodyHtml: html, styles: [] };
    }
    const styles = [];
    const htmlWithoutStyles = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css) => {
      if (css) styles.push(scopeOverlayDocumentCss(css));
      return "";
    });
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(htmlWithoutStyles);
    const bodyHtml = bodyMatch ? bodyMatch[1] : htmlWithoutStyles;
    return {
      bodyHtml: bodyHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""),
      styles,
    };
  }

  function resolveOverlayTab(tab) {
    const hasHtml = typeof tab.html === "string" && tab.html.length > 0;
    const hasTemplate = tab.template && typeof tab.template === "object";
    if (hasHtml && hasTemplate) {
      throw new Error("overlay.open accepts either html or template, not both");
    }
    if (!hasHtml && !hasTemplate) {
      throw new Error("overlay.open requires either a non-empty html string or a template storage reference");
    }
    if (hasHtml) return { ...tab, html: tab.html, templateDriven: false };

    const templateAsset = resolveStorageAsset(tab.template, "Overlay template asset");
    let dataAsset = null;
    let dataValue = null;
    if (tab.data) {
      dataAsset = resolveStorageAsset(tab.data, "Overlay data asset");
      try {
        dataValue = JSON.parse(dataAsset.text || "null");
      } catch (_error) {
        throw new Error(`Overlay data asset is not valid JSON: ${dataAsset.path}`);
      }
    }
    return {
      ...tab,
      html: templateAsset.text,
      templateDriven: true,
      template: tab.template,
      data: tab.data || null,
      dataValue,
    };
  }

  function resolveStorageAsset(ref, label) {
    const canonicalPath = canonicalPathFromStorageRef(ref);
    const text = storageFileText(canonicalPath);
    if (text === null || text === undefined) {
      throw new Error(`${label} not found: ${canonicalPath}`);
    }
    return { path: canonicalPath, text };
  }

  function canonicalPathFromStorageRef(ref) {
    if (!ref || typeof ref !== "object") {
      throw new Error("Storage asset reference must be an object");
    }
    const rawPath = normalizeStorageRefPath(ref.path);
    if (rawPath.startsWith("scopes/")) return rawPath;
    const scope = normalizeStorageRefScope(ref.scope || BARE_SITE_FALLBACK_SCOPE);
    if (scope.startsWith("shared:")) {
      return `scopes/shared/${scope.slice("shared:".length)}/${rawPath}`;
    }
    return `scopes/${scope}/${rawPath}`;
  }

  function normalizeStorageRefScope(scope) {
    const value = String(scope || BARE_SITE_FALLBACK_SCOPE).trim();
    if (value === "private" || value === "public") return value;
    const sharedMatch = value.match(/^shared[:/](.+)$/);
    if (sharedMatch && /^[a-z0-9._-]+$/i.test(sharedMatch[1])) {
      return `shared:${sharedMatch[1]}`;
    }
    throw new Error(`Unknown storage scope: ${value}`);
  }

  function normalizeStorageRefPath(path) {
    const value = String(path || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
    if (!value) throw new Error("Storage asset path is required");
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unsafe storage path: ${path}`);
    }
    return parts.join("/");
  }

  function buildTemplateDocumentHtml({ html, data }) {
    const dataScript = `<script type="application/json" data-actions-json-overlay-data>${jsonForScriptText(data)}</script>`;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${dataScript}`);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${dataScript}</head>`);
    }
    return `<!doctype html><html><head>${dataScript}</head><body>${html}</body></html>`;
  }

  function jsonForScriptText(value) {
    return JSON.stringify(value ?? null)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
  }

  function setTabStyles(tabId, styles) {
    for (const style of shadow.querySelectorAll("style[data-actions-json-tab-style]")) {
      if (style.dataset.actionsJsonTabStyle === tabId) style.remove();
    }
    if (!styles.length) return;
    const style = document.createElement("style");
    style.dataset.actionsJsonTabStyle = tabId;
    style.textContent = styles.join("\n");
    shadow.appendChild(style);
  }

  function createHtmlBlobUrl(html) {
    return URL.createObjectURL(new Blob([html], { type: "text/html" }));
  }

  function scopeOverlayDocumentCss(css) {
    return String(css || "").replace(/(^|[{}])\s*([^@{}][^{}]*)\{/g, (match, prefix, selectors) => {
      const scopedSelectors = selectors
        .split(",")
        .map((selector) => {
          const trimmed = selector.trim();
          if (trimmed === ":root" || trimmed === "html" || trimmed === "body") return ".tab-content";
          if (trimmed.startsWith("body.")) return `.tab-content${trimmed.slice(4)}`;
          if (trimmed.startsWith("html.")) return `.tab-content${trimmed.slice(4)}`;
          return trimmed;
        })
        .join(", ");
      return `${prefix} ${scopedSelectors} {`;
    });
  }

  function clearTabBlobUrl(panelElement) {
    const blobUrl = panelElement.dataset.actionsJsonBlobUrl;
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      delete panelElement.dataset.actionsJsonBlobUrl;
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function startDrag(event, options = {}) {
    if (event.target.closest("button") && !collapsed) return;
    const rect = root.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    root.style.inset = "auto auto auto auto";
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 3) {
        moved = true;
      }
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - 48);
      const left = Math.min(Math.max(0, moveEvent.clientX - offsetX), maxLeft);
      const top = Math.min(Math.max(0, moveEvent.clientY - offsetY), maxTop);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };
    const onUp = () => {
      if (collapsed && moved && options.suppressClickOnMove) {
        suppressNextCollapseClick = true;
        setTimeout(() => {
          suppressNextCollapseClick = false;
        }, 250);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function renderStatus(message) {
    const bundle = loadBundle();
    const lines = [
      formatStorageDiagnostics({
        currentUrl: location.href,
        selectedFolderName: storageDirectoryHandle?.name || null,
        folderRead: lastFolderRead,
        bundle,
        message,
      }),
    ];
    lines.push(
      "",
      `Bridge: ${bridgeConnected ? transportMode : "waiting"}`,
      `Bridge URL: ${BRIDGE_URL}`,
    );
    if (!("showDirectoryPicker" in window)) {
      lines.push("", "Folder read/write is unavailable in this browser.");
    }
    status.textContent = lines.join("\n");
  }

  function protocolSend(item) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(item));
      return;
    }
    if (relayActive) {
      window.postMessage(
        {
          source: BOOKMARKLET_RELAY_SOURCE,
          direction: "page-to-extension",
          item,
        },
        "*",
      );
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isHumanInteractionAction(name) {
    return name === "viewport.scroll" || name.startsWith("pointer.") || name === "text.insert" || name === "keyboard.press";
  }

  async function waitForHumanInteractionSlot(name) {
    if (!isHumanInteractionAction(name)) return 0;
    const elapsed = Date.now() - lastHumanInteractionStartedAt;
    const waitMs = lastHumanInteractionStartedAt ? Math.max(0, minPrimitiveIntervalMs - elapsed) : 0;
    if (waitMs > 0) await sleep(waitMs);
    lastHumanInteractionStartedAt = Date.now();
    return waitMs;
  }

  function annotatePrimitivePacing(output, waitMs) {
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
  }

  function configurePrimitivePacing(args = {}) {
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
  }

  function buildManifest() {
    return {
      primitive_dictionary: primitiveDictionaryMetadata,
      tools: [...baseManifest.tools, ...loadStoredActionTools()],
    };
  }

  function announceRuntimeReady() {
    protocolSend({
      type: "runtime_ready",
      runtime_id: RUNTIME_ID,
      runtime_key: `bookmarklet:${location.origin}`,
      authorization_id: null,
      extension_version: `bookmarklet-${BOOKMARKLET_VERSION}`,
      url: location.href,
      manifest: buildManifest(),
    });
  }

  function runtimeStatusMessage() {
    return {
      type: "runtime_status",
      runtime_id: RUNTIME_ID,
      runtime_key: `bookmarklet:${location.origin}`,
      authorization_id: null,
      extension_version: `bookmarklet-${BOOKMARKLET_VERSION}`,
      url: location.href,
      connected: true,
      actions: buildManifest().tools.map((tool) => tool.name),
    };
  }

  function startExtensionRelay(message) {
    if (!shouldReconnect) return;
    relayActive = true;
    transportMode = "extension relay";
    bridgeConnected = true;
    renderStatus(message || "Connected via extension relay.");
    announceRuntimeReady();
    startRelayAnnouncement();
  }

  function startRelayAnnouncement() {
    if (relayAnnounceTimer) return;
    relayAnnounceTimer = setInterval(() => {
      if (!relayActive || !shouldReconnect) {
        stopRelayAnnouncement();
        return;
      }
      announceRuntimeReady();
    }, 1500);
  }

  function stopRelayAnnouncement() {
    if (relayAnnounceTimer) {
      clearInterval(relayAnnounceTimer);
      relayAnnounceTimer = null;
    }
  }

  async function handleProtocolMessage(message) {
    if (message.type === "action_call") {
      if (message.runtime_id && message.runtime_id !== RUNTIME_ID) return;
      await enqueueActionCall(message);
    } else if (message.type === "runtime_status") {
      protocolSend(runtimeStatusMessage());
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const envelope = event.data || {};
    if (envelope.source !== EXTENSION_RELAY_SOURCE || envelope.direction !== "extension-to-page") return;
    const item = envelope.item || {};
    if (item.runtime_id && item.runtime_id !== RUNTIME_ID) return;
    handleProtocolMessage(item).catch((error) => {
      protocolSend({
        type: "action_error",
        call_id: item.call_id || crypto.randomUUID(),
        runtime_id: RUNTIME_ID,
        error: {
          code: "handler_failed",
          message: error.message || String(error),
        },
      });
    });
  });

  async function connect(bridgeUrl) {
    if (!shouldReconnect) return;
    clearTimeout(reconnectTimer);
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }

    socket = new WebSocket(bridgeUrl);
    socket.addEventListener("open", () => {
      relayActive = false;
      stopRelayAnnouncement();
      transportMode = "direct";
      bridgeConnected = true;
      renderStatus("Connected to actions.json MCP bridge.");
      announceRuntimeReady();
    });
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      await handleProtocolMessage(message);
    });
    socket.addEventListener("close", () => {
      if (!bridgeConnected) {
        startExtensionRelay("Direct bridge unavailable; waiting through extension relay.");
        return;
      }
      if (relayActive) return;
      bridgeConnected = false;
      transportMode = "direct";
      renderStatus("Waiting for actions.json MCP bridge.");
      if (shouldReconnect) {
        reconnectTimer = setTimeout(() => connect(bridgeUrl).catch(() => {}), 1500);
      }
    });
    socket.addEventListener("error", () => {
      if (!bridgeConnected) {
        startExtensionRelay("Direct bridge blocked; waiting through extension relay.");
        return;
      }
      bridgeConnected = false;
      renderStatus("Waiting for actions.json MCP bridge.");
    });
  }

  async function handleActionCall(message) {
    const callId = message.call_id || crypto.randomUUID();
    try {
      const rateLimitWaitMs = await waitForHumanInteractionSlot(message.name);
      let output;
      if (message.name === "storage.import_bundle") {
        output = importStorageSyncBundle(message.arguments || {});
      } else if (message.name === "overlay.open") {
        output = openTab(message.arguments || {});
      } else if (message.name === "overlay.register_launcher") {
        output = installLaunchers(message.arguments || {});
      } else if (message.name === "overlay.close") {
        output = closeOverlayTabs();
      } else if (message.name === "storage.list") {
        output = listStorageBundle();
      } else if (message.name === "runtime.configure_pacing") {
        output = configurePrimitivePacing(message.arguments || {});
      } else if (message.name === "browser.run_javascript") {
        output = await runJavascript(message.arguments || {});
      } else if (message.name === "browser.screenshot") {
        output = await captureUserConsentedScreenshot(message.arguments || {});
      } else if (message.name === "browser.extract_elements") {
        output = await extractElements(message.arguments || {});
      } else if (message.name === "locator.element_info") {
        output = await locatorElementInfo(message.arguments || {});
      } else if (message.name === "locator.text_content") {
        output = locatorTextContent(message.arguments || {});
      } else if (message.name === "locator.wait_for") {
        output = await locatorWaitFor(message.arguments || {});
      } else if (message.name === "pointer.click") {
        output = pointerClick(message.arguments || {});
      } else if (message.name === "pointer.move") {
        output = pointerMove(message.arguments || {});
      } else if (message.name === "pointer.double_click") {
        output = pointerDoubleClick(message.arguments || {});
      } else if (message.name === "pointer.drag") {
        output = pointerDrag(message.arguments || {});
      } else if (message.name === "viewport.scroll") {
        output = await viewportScroll(message.arguments || {});
      } else if (message.name === "text.insert") {
        output = await textInsert(message.arguments || {});
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
      } else if (findStoredAction(message.name)) {
        output = await executeStoredAction(message.name, message.arguments || {});
      } else {
        throw new Error(`Unknown action: ${message.name}`);
      }
      renderStatus(`Handled ${message.name}.`);
      protocolSend({
        type: "action_call_output",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        output: annotatePrimitivePacing(output, rateLimitWaitMs),
      });
    } catch (error) {
      protocolSend({
        type: "action_error",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        error: {
          code: "handler_failed",
          message: error.message || String(error),
        },
      });
    }
  }

  function enqueueActionCall(message) {
    const run = primitiveQueue.then(() => handleActionCall(message));
    primitiveQueue = run.catch(() => {});
    return run;
  }

  function primitiveSuccess(primitive, value) {
    return {
      ok: true,
      primitive,
      adapter: "embed",
      value,
    };
  }

  function primitiveError(primitive, code, message, evidence = {}) {
    return {
      ok: false,
      primitive,
      adapter: "embed",
      error: {
        code,
        message,
        recoverable: true,
        evidence,
      },
    };
  }

  async function locatorElementInfo(args = {}) {
    const locator = args.locator;
    const renderedCandidates = resolveLocatorCandidates(locator).filter(isElementRendered);
    const element = renderedCandidates[0] || null;
    if (!element) {
      return primitiveError(
        "locator.element_info",
        "target_not_found",
        "No visible element matched the locator.",
        { locator },
      );
    }
    const visibility = await ensureElementInView(element, { auto_scroll: args.auto_scroll ?? args.autoScroll ?? true });
    if (!visibility.current.clickable) {
      return primitiveError("locator.element_info", "target_not_actionable", "Element matched the locator but is not currently clickable.", {
        locator,
        initial_visibility: publicVisibility(visibility.initial),
        visibility: publicVisibility(visibility.current),
        scroll_operations_performed: visibility.performed.map(publicScrollOperation),
      });
    }
    const rect = element.getBoundingClientRect();
    const visibleRect = visibility.current.visible_rect || rect;
    const visibleCandidates = renderedCandidates.filter(isElementVisible);
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
        bottom: rect.bottom,
      },
      clickable_center: {
        x: visibleRect.left + (visibleRect.right - visibleRect.left) / 2,
        y: visibleRect.top + (visibleRect.bottom - visibleRect.top) / 2,
      },
      clickable: visibility.current.clickable,
      visibility: publicVisibility(visibility.current),
      initial_visibility: publicVisibility(visibility.initial),
      ambiguous: visibleCandidates.length > 1,
      candidate_count: visibleCandidates.length,
      scroll_operations_performed: visibility.performed.map(publicScrollOperation),
    });
  }

  function resolveSingleVisibleLocator(locator) {
    return resolveLocatorCandidates(locator).find(isElementVisible) || null;
  }

  function resolveSingleLocator(locator) {
    return resolveLocatorCandidates(locator)[0] || null;
  }

  function resolveLocatorCandidates(locator) {
    if (!locator || typeof locator !== "object") {
      return [];
    }
    let candidates = [];
    if (typeof locator.selector === "string" && locator.selector.trim()) {
      candidates = queryRelative(document, locator.selector.trim(), { visible_only: false });
    } else {
      candidates = Array.from(document.querySelectorAll("button, a, input, textarea, select, [role], [aria-label], [data-testid], [data-test], [data-actions-json-target]"));
    }
    const text = normalizeText(locator.text || locator.text_contains || locator.text_equals);
    if (!text) {
      return candidates;
    }
    return candidates
      .filter((element) => {
        const haystack = normalizeText(
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("value"),
          ].filter(Boolean).join(" "),
        );
        return locator.text_equals ? haystack === text : haystack.includes(text);
      });
  }

  function pointerClick(args = {}) {
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
  }

  function pointerMove(args = {}) {
    const x = Number(args.x);
    const y = Number(args.y);
    const viewportError = validateViewportPoint("pointer.move", x, y, args);
    if (viewportError) return viewportError;
    moveVisiblePointer(x, y);
    return primitiveSuccess("pointer.move", { x, y });
  }

  function pointerDoubleClick(args = {}) {
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
      view: window,
    }));
    return primitiveSuccess("pointer.double_click", { double_clicked: true, x, y });
  }

  function pointerDrag(args = {}) {
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
  }

  function validateViewportPoint(primitive, x, y, evidence) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return primitiveError(primitive, "point_out_of_viewport", "Point is outside the current viewport.", {
        x: evidence?.x,
        y: evidence?.y,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    }
    return null;
  }

  function moveVisiblePointer(x, y) {
    let pointer = document.getElementById("actions-json-ghost-pointer");
    if (!pointer) {
      pointer = document.createElement("div");
      pointer.id = "actions-json-ghost-pointer";
      pointer.setAttribute("aria-hidden", "true");
      pointer.style.position = "fixed";
      pointer.style.width = "14px";
      pointer.style.height = "14px";
      pointer.style.margin = "-7px 0 0 -7px";
      pointer.style.border = "2px solid #38bdf8";
      pointer.style.borderRadius = "999px";
      pointer.style.background = "rgba(56, 189, 248, 0.28)";
      pointer.style.boxShadow = "0 0 0 4px rgba(56, 189, 248, 0.18)";
      pointer.style.zIndex = "2147483646";
      pointer.style.pointerEvents = "none";
      pointer.style.transition = "left 120ms ease, top 120ms ease, transform 120ms ease";
      document.documentElement.appendChild(pointer);
    }
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
    pointer.style.transform = "scale(1.25)";
    setTimeout(() => {
      pointer.style.transform = "scale(1)";
    }, 140);
  }

  function dispatchPointerClick(target, { x, y, button, detail = 1 }) {
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
    };
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventCtor(type, common));
    }
  }

  function dispatchPointerEvent(target, type, { x, y, buttons = 0, button = 0, eventCtor = null }) {
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
      view: window,
    }));
  }

  async function captureUserConsentedScreenshot(args = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("browser.screenshot requires navigator.mediaDevices.getDisplayMedia support");
    }
    const requestId = `screenshot-${Date.now().toString(36)}`;
    openTab({
      id: requestId,
      title: "Screenshot Request",
      html: `
        <div class="field">
          <span>Screenshot authorization</span>
          <p class="muted">
            The agent requested a rendered browser screenshot. Click Capture screenshot, then choose this tab
            or the intended browser surface in Chrome's permission dialog.
          </p>
          <div class="row">
            <button data-capture-screenshot>Capture screenshot</button>
            <button data-cancel-screenshot>Cancel</button>
          </div>
          <pre data-screenshot-status>Waiting for your approval.</pre>
        </div>
      `,
    });
    const panelElement = overlayTabs.get(requestId)?.panelElement;
    if (!panelElement) {
      throw new Error("Failed to open screenshot authorization tab");
    }
    const captureButton = panelElement.querySelector("[data-capture-screenshot]");
    const cancelButton = panelElement.querySelector("[data-cancel-screenshot]");
    const requestStatus = panelElement.querySelector("[data-screenshot-status]");

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        captureButton?.removeEventListener("click", onCapture);
        cancelButton?.removeEventListener("click", onCancel);
      };
      const onCancel = () => {
        cleanup();
        if (requestStatus) requestStatus.textContent = "Screenshot request cancelled.";
        reject(new Error("Screenshot request cancelled by user"));
      };
      const onCapture = async () => {
        cleanup();
        try {
          captureButton.disabled = true;
          cancelButton.disabled = true;
          if (requestStatus) requestStatus.textContent = "Waiting for browser capture permission...";
          const output = await captureDisplayMediaFrame(args, requestId);
          if (requestStatus) requestStatus.textContent = `Captured ${output.width}×${output.height}.`;
          resolve(output);
        } catch (error) {
          if (requestStatus) requestStatus.textContent = `Screenshot failed: ${error.message || error}`;
          reject(error);
        } finally {
          captureButton.disabled = false;
          cancelButton.disabled = false;
        }
      };
      captureButton?.addEventListener("click", onCapture, { once: true });
      cancelButton?.addEventListener("click", onCancel, { once: true });
    });
  }

  async function captureDisplayMediaFrame(args = {}, requestId = "screenshot") {
    const delayMs = Math.min(Math.max(Number(args.delay_ms) || 0, 0), 30000);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    });
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for captured video frame")), 5000);
        video.addEventListener("loadedmetadata", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        const playResult = video.play();
        if (playResult?.catch) {
          playResult.catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
        }
      });
      const trackSettings = stream.getVideoTracks?.()[0]?.getSettings?.() || {};
      const sourceWidth = video.videoWidth || trackSettings.width || 1;
      const sourceHeight = video.videoHeight || trackSettings.height || 1;
      const { width, height } = constrainedImageSize(sourceWidth, sourceHeight, args);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");
      context.drawImage(video, 0, 0, width, height);
      const format = args.format === "jpeg" ? "jpeg" : "png";
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const quality = format === "jpeg" ? normalizedQuality(args.quality) : undefined;
      const dataUrl = canvas.toDataURL(mimeType, quality);
      const result = {
        ok: true,
        data_url: dataUrl,
        mime_type: mimeType,
        image_bytes: imageBytesFromDataUrl(dataUrl),
        width,
        height,
        source_width: sourceWidth,
        source_height: sourceHeight,
        url: location.href,
        captured_at: new Date().toISOString(),
        capture_method: "getDisplayMedia",
        rendered: true,
        user_consented: true,
        tab_id: requestId,
      };
      openTab({
        id: `${requestId}-result`,
        title: "Screenshot",
        html: `<img alt="Captured screenshot" src="${escapeAttribute(dataUrl)}"><pre>${escapeHtml(JSON.stringify({
          width,
          height,
          capture_method: result.capture_method,
          image_bytes: result.image_bytes,
        }, null, 2))}</pre>`,
      });
      return result;
    } finally {
      for (const track of stream.getTracks?.() || stream.getVideoTracks?.() || []) {
        track.stop?.();
      }
    }
  }

  function constrainedImageSize(width, height, args = {}) {
    const maxWidth = Number(args.max_width) || width;
    const maxHeight = Number(args.max_height) || height;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function normalizedQuality(value) {
    const quality = Number(value);
    if (!Number.isFinite(quality)) return 0.82;
    return Math.min(1, Math.max(0.01, quality / 100));
  }

  function imageBytesFromDataUrl(dataUrl) {
    const base64 = String(dataUrl || "").split(",")[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function importStorageSyncBundle(args = {}) {
    const bundle = args.bundle;
    if (bundle?.protocol !== "actions.json.storage.bundle" || !Array.isArray(bundle.entries)) {
      throw new Error("storage.import_bundle requires an actions.json.storage.bundle");
    }
    const entries = bundle.entries.map((entry) => ({
      path: entry.path,
      text: String(entry.content ?? ""),
      size: entry.bytes ?? String(entry.content ?? "").length,
      lastModified: null,
    }));
    const browserBundle = buildRelevantStorageBundle(entries, {
      currentUrl: location.href,
      defaultScope: BARE_SITE_FALLBACK_SCOPE,
    });
    browserBundle.synced_at_ms = bundle.synced_at_ms ?? null;
    browserBundle.imported_at = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(browserBundle));
    announceRuntimeReady();
    return {
      ok: true,
      entry_count: browserBundle.fileCount,
      rejected_count: browserBundle.rejected.length,
      synced_at_ms: browserBundle.synced_at_ms,
    };
  }

  function listStorageBundle() {
    const bundle = loadBundle();
    const paths = Object.keys(bundle?.files || {}).sort();
    return {
      ok: true,
      protocol: bundle?.protocol || null,
      version: bundle?.version || null,
      synced_at_ms: bundle?.synced_at_ms || null,
      imported_at: bundle?.imported_at || null,
      entry_count: paths.length,
      paths,
    };
  }

  function loadStoredActionManifests() {
    const bundle = loadBundle();
    return Object.entries(bundle?.files || {})
      .filter(([filePath]) => filePath.endsWith("/actions.json"))
      .map(([filePath, file]) => {
        try {
          return { filePath, manifest: JSON.parse(file.text || "{}") };
        } catch (error) {
          console.warn("[actions.json] failed to parse stored actions manifest", filePath, error);
          return null;
        }
      })
      .filter(Boolean)
      .filter(({ manifest }) => manifest?.protocol === "actions.json");
  }

  function loadStoredActionTools() {
    return loadStoredActionManifests()
      .flatMap(({ manifest }) => manifest.tools || [])
      .filter((tool) => typeof tool?.name === "string" && tool.x_actions?.javascript);
  }

  function findStoredAction(name) {
    return loadStoredActionTools().find((tool) => tool.name === name) || null;
  }

  async function executeStoredAction(name, args = {}) {
    const tool = findStoredAction(name);
    if (!tool) {
      throw new Error(`Unknown stored action: ${name}`);
    }
    const javascript = tool.x_actions?.javascript;
    const source = javascript?.source || javascript?.body;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`Stored action ${name} does not declare x_actions.javascript.source`);
    }
    return runJavascript({ source, args });
  }

  async function runJavascript(args = {}) {
    const source = args.source || args.javascript;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("browser.run_javascript requires source");
    }
    const actionArgs = args.args && typeof args.args === "object" ? args.args : {};
    const helpers = {
      normalizeText,
      isElementVisible,
      queryRelative,
      storageFileText,
        loadStorageJson,
        actionsJson: {
          openTab,
          installLaunchers,
        },
      };
    const action = new Function(
      "args",
      "helpers",
      `"use strict"; return (async () => {\n${source}\n})()`
    );
    return {
      ok: true,
      result: await action(actionArgs, helpers),
      url: location.href,
    };
  }

  function pageInfo() {
    return primitiveSuccess("page.info", {
      url: location.href,
      title: document.title,
    });
  }

  function domObserveVisible(args = {}) {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "*";
    const textContains = normalizeText(args.text_contains || args.textContains).toLowerCase();
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch (_error) {
      return primitiveError("dom.observe.visible", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const matches = candidates
      .filter(isElementVisible)
      .filter((element) => {
        if (!textContains) return true;
        return normalizeText(element.textContent || element.getAttribute("aria-label")).toLowerCase().includes(textContains);
      })
      .slice(0, Math.max(1, Math.min(Number(args.max_matches ?? args.maxMatches ?? 50), 200)))
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
            bottom: rect.bottom,
          },
        };
      });
    return primitiveSuccess("dom.observe.visible", { matches, match_count: matches.length });
  }

  function deriveSectionHeading(section, headingSelector, maxHeadingLength) {
    const selectors = headingSelector ? [headingSelector] : ["h1,h2,h3,h4,h5,h6,[role='heading'],[aria-label]"];
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
  }

  function domListSections(args = {}) {
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
      url: location.href,
    });
  }

  function domSnapshotText(args = {}) {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "body";
    const maxChars = Math.max(1, Math.min(Number(args.max_chars ?? args.maxChars ?? 12000), 100000));
    let elements;
    try {
      elements = Array.from(document.querySelectorAll(selector)).filter(isElementVisible);
    } catch (_error) {
      return primitiveError("dom.snapshot_text", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const text = normalizeText(elements.map((element) => element.textContent || "").join("\n")).slice(0, maxChars);
    return primitiveSuccess("dom.snapshot_text", { text, truncated: text.length >= maxChars });
  }

  function locatorTextContent(args = {}) {
    const locator = args.locator;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return primitiveError("locator.text_content", "target_not_found", "No visible element matched the locator.", { locator });
    }
    return primitiveSuccess("locator.text_content", {
      locator,
      text: normalizeText(element.textContent || element.getAttribute("aria-label")),
    });
  }

  async function locatorWaitFor(args = {}) {
    const locator = args.locator;
    const state = args.state || "visible";
    const timeoutMs = Math.max(0, Math.min(Number(args.timeout_ms ?? args.timeoutMs ?? 1000), 30000));
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const element = state === "attached" ? resolveSingleLocator(locator) : resolveSingleVisibleLocator(locator);
      if (element) {
        return primitiveSuccess("locator.wait_for", { matched: true, state, elapsed_ms: Date.now() - started });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return primitiveError("locator.wait_for", "timeout", "Timed out waiting for locator.", {
      locator,
      state,
      timeout_ms: timeoutMs,
    });
  }

  function waitForEditableHandlers() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  function selectEditableContents(target, mode) {
    const selection = window.getSelection?.();
    const range = document.createRange();
    const textNodes = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && node.nodeValue.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
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
  }

  function syntheticClipboardEvent(text) {
    let clipboardData = null;
    if (typeof DataTransfer === "function") {
      clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      clipboardData.setData("text/html", text.replace(/[&<>"]/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
      }[char])));
    }
    let event;
    try {
      event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData,
      });
    } catch (_error) {
      event = new Event("paste", { bubbles: true, cancelable: true, composed: true });
    }
    if (clipboardData && !event.clipboardData) {
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
    }
    return event;
  }

  async function textInsert(args = {}) {
    const text = String(args.text ?? "");
    const target = document.activeElement;
    if (!isEditableElement(target)) {
      return primitiveError("text.insert", "target_not_editable", "The active element is not editable.", {
        tag_name: target?.tagName?.toLowerCase?.() || null,
      });
    }

    const mode = args.mode === "replace" ? "replace" : "append";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = mode === "replace" ? 0 : Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
      const end = mode === "replace" ? target.value.length : Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      const beforeInputType = mode === "replace" ? "insertReplacementText" : "insertText";
      target.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: beforeInputType,
        data: text,
      }));
      const nextValue = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
      const prototype = Object.getPrototypeOf(target);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      const ownValueSetter = Object.getOwnPropertyDescriptor(target, "value")?.set;
      const valueSetter = prototypeValueSetter || ownValueSetter;
      if (valueSetter) {
        valueSetter.call(target, nextValue);
      } else {
        target.value = nextValue;
      }
      const cursor = start + text.length;
      target.setSelectionRange?.(cursor, cursor);
    } else {
      const beforePasteText = target.textContent || "";
      const selectedText = selectEditableContents(target, mode);
      document.dispatchEvent(new Event("selectionchange", { bubbles: false }));
      await waitForEditableHandlers();
      const pasteEvent = syntheticClipboardEvent(text);
      const dispatched = target.dispatchEvent(pasteEvent);
      await waitForEditableHandlers();
      const afterPasteText = target.textContent || "";
      if (!dispatched || pasteEvent.defaultPrevented || afterPasteText !== beforePasteText) {
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return primitiveSuccess("text.insert", {
          inserted: true,
          inserted_length: text.length,
          input_method: "synthetic-paste",
          selected_text_length: selectedText.length,
          selection_sync: "selectionchange+animation-frame",
        });
      }
      selectEditableContents(target, mode);
      const inserted = document.execCommand?.("insertText", false, text);
      if (!inserted) target.textContent = mode === "append" ? `${target.textContent || ""}${text}` : text;
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return primitiveSuccess("text.insert", {
      inserted: true,
      inserted_length: text.length,
      input_method: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? "native-value-setter+input" : undefined,
    });
  }

  function keyboardPress(args = {}) {
    const key = String(args.key || "");
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    if (!key || modifiers.length > 0) {
      return primitiveError("keyboard.press", "capability_unavailable", "Bookmarklet can only dispatch page-level unmodified key events.", {
        key,
        modifiers,
        reason: "trusted_key_events_unavailable",
      });
    }
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
    return primitiveSuccess("keyboard.press", { pressed: true, key, fidelity: "page_level" });
  }

  function viewportScroll(args = {}) {
    const deltaX = Number(args.delta_x ?? args.deltaX ?? args.scroll_x ?? args.scrollX ?? 0);
    const deltaY = Number(args.delta_y ?? args.deltaY ?? args.scroll_y ?? args.scrollY ?? 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return primitiveError("viewport.scroll", "scroll_failed", "Scroll deltas must be finite numbers.", {
        delta_x: args.delta_x,
        delta_y: args.delta_y,
      });
    }

    let target = window;
    let targetKind = "viewport";
    if (args.scope && typeof args.scope === "object") {
      const scopeElement = findScopedElement(args.scope);
      if (!scopeElement) {
        return primitiveError("viewport.scroll", "target_not_found", "No visible element matched the scroll scope.", { scope: args.scope });
      }
      const root = findExtractionRoot(scopeElement, args.item_selector || args.itemSelector, args.scope);
      const scrollable = findScrollableElement(root, deltaX, deltaY);
      if (!scrollable) {
        return primitiveError("viewport.scroll", "target_not_scrollable", "No scrollable element was found for the requested scope.", {
          scope: args.scope,
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

    const after = target === window
      ? { scroll_x: window.scrollX, scroll_y: window.scrollY }
      : { scroll_x: target.scrollLeft, scroll_y: target.scrollTop };

    return primitiveSuccess("viewport.scroll", {
      moved: after.scroll_x !== before.scroll_x || after.scroll_y !== before.scroll_y,
      target: targetKind,
      before,
      after,
      delta_x: deltaX,
      delta_y: deltaY,
    });
  }

  function extractElements(args = {}) {
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
        selector_count: selectorListFrom(scope, ["body"]).length,
      },
      items,
      item_count: items.length,
      extracted_at: new Date().toISOString(),
      url: location.href,
    };
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isElementVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    return Boolean(visibleRectFor(element));
  }

  function isElementRendered(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function rectFromClientRect(rect) {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  }

  function rectWidth(rect) {
    return Math.max(0, rect.right - rect.left);
  }

  function rectHeight(rect) {
    return Math.max(0, rect.bottom - rect.top);
  }

  function rectArea(rect) {
    return rectWidth(rect) * rectHeight(rect);
  }

  function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top };
  }

  function viewportRect() {
    return {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
      x: 0,
      y: 0,
    };
  }

  function overflowClips(value) {
    return value && value !== "visible" && value !== "clip";
  }

  function elementLabel(element) {
    if (!(element instanceof Element)) return null;
    const id = element.id ? `#${element.id}` : "";
    const testId = element.getAttribute("data-testid");
    const testLabel = testId ? `[data-testid="${testId}"]` : "";
    const className = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    return `${element.tagName.toLowerCase()}${id}${testLabel}${className}`;
  }

  function clippingAncestorsFor(element) {
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
            label: elementLabel(parent),
          });
        }
      }
      parent = parent.parentElement;
    }
    return ancestors;
  }

  function scrollOperationFor(element, geometry) {
    if (!geometry?.rendered) return null;
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
          max_scroll_y: ancestor.max_scroll_top,
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
        max_scroll_y: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      };
    }
    return null;
  }

  function visibilityGeometryFor(element) {
    const rendered = isElementRendered(element);
    const rect = element instanceof Element ? rectFromClientRect(element.getBoundingClientRect()) : null;
    if (!rendered || !rect) {
      return {
        state: "not_rendered",
        rendered: false,
        visible: false,
        clickable: false,
        fully_visible: false,
        bounding_box: rect,
        visible_rect: null,
        visible_ratio: 0,
        scroll_operation: null,
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
          overflow_y: ancestor.overflow_y,
        });
      }
    }
    const area = rectArea(rect);
    const visibleArea = visibleRect ? rectArea(visibleRect) : 0;
    const visibleRatio = area > 0 ? visibleArea / area : 0;
    const fullyVisible = visibleRatio >= 0.98;
    const clickable = Boolean(visibleRect && rectWidth(visibleRect) >= 8 && rectHeight(visibleRect) >= 8);
    const geometry = {
      state: fullyVisible ? "visible" : "requires_scroll",
      rendered: true,
      visible: Boolean(visibleRect),
      clickable,
      fully_visible: fullyVisible,
      bounding_box: rect,
      visible_rect: visibleRect,
      visible_ratio: visibleRatio,
      clipped_by: clippedBy,
      clipping_ancestors: clippingAncestors,
    };
    geometry.scroll_operation = fullyVisible ? null : scrollOperationFor(element, geometry);
    return geometry;
  }

  function publicVisibility(geometry) {
    if (!geometry) return null;
    const { clipping_ancestors: _ancestors, ...publicGeometry } = geometry;
    if (publicGeometry.scroll_operation?.target_element) {
      const { target_element: _targetElement, ...publicOperation } = publicGeometry.scroll_operation;
      publicGeometry.scroll_operation = publicOperation;
    }
    return publicGeometry;
  }

  function publicScrollOperation(operation) {
    if (!operation) return null;
    const { target_element: _targetElement, ...publicOperation } = operation;
    return publicOperation;
  }

  async function performScrollOperation(operation) {
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
  }

  async function ensureElementInView(element, options = {}) {
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
  }

  function isRectInViewport(rect) {
    return rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth;
  }

  function visibleRectFor(element) {
    return visibilityGeometryFor(element).visible_rect;
  }

  function selectorListFrom(input, fallback = []) {
    if (!input || typeof input !== "object") return fallback;
    const values = [];
    if (typeof input.selector === "string") values.push(input.selector);
    if (Array.isArray(input.selectors)) values.push(...input.selectors);
    return values.map((value) => String(value || "").trim()).filter(Boolean).concat(fallback);
  }

  function findScopedElement(scope = {}) {
    const selectors = selectorListFrom(scope, ["body"]);
    const candidates = [];
    for (const selector of selectors) {
      try {
        candidates.push(...Array.from(document.querySelectorAll(selector)));
      } catch (_error) {
        // Invalid selector hints are ignored; another selector can still match.
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
  }

  function countVisibleMatches(rootElement, selector) {
    try {
      return Array.from(rootElement.querySelectorAll(selector)).filter(isElementVisible).length;
    } catch (_error) {
      return 0;
    }
  }

  function findExtractionRoot(scopeElement, itemSelector, scope = {}) {
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
  }

  function queryRelative(rootElement, selector, options = {}) {
    const visibleOnly = options.visible_only ?? options.visibleOnly ?? true;
    const rootNode = rootElement || document;
    const matches = [];
    for (const part of String(selector || "").split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed === ":scope") {
        matches.push(rootNode);
        continue;
      }
      try {
        if (rootNode.matches?.(trimmed)) matches.push(rootNode);
      } catch (_error) {
        // Some relative selectors are valid only through querySelectorAll.
      }
      try {
        matches.push(...Array.from(rootNode.querySelectorAll(trimmed)));
      } catch (_error) {
        // Invalid selectors are ignored so one bad field rule does not abort the action.
      }
    }
    const uniqueMatches = Array.from(new Set(matches));
    return visibleOnly ? uniqueMatches.filter(isElementVisible) : uniqueMatches;
  }

  function readAttributeValue(element, attribute) {
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
  }

  function extractFieldValue(itemRoot, field) {
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
  }

  function extractItemsFromRoot(rootElement, args) {
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
      itemRoots = Array.from(rootElement.querySelectorAll(itemSelector)).filter(isElementVisible);
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
  }

  function findScrollableElement(rootElement, deltaX, deltaY) {
    if (!(rootElement instanceof Element)) return null;
    const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
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
  }

  function isEditableElement(element) {
    if (!element) return false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    return element.isContentEditable;
  }

  function storageFileText(path) {
    const bundle = loadBundle();
    if (!bundle?.files) return null;
    if (bundle.files[path]) return bundle.files[path].text ?? null;
    const parsed = parseStoragePath(path, { defaultScope: BARE_SITE_FALLBACK_SCOPE });
    if (parsed && bundle.files[parsed.canonicalPath]) {
      return bundle.files[parsed.canonicalPath].text ?? null;
    }
    return null;
  }

  function loadStorageJson(path) {
    const text = storageFileText(path);
    return text ? JSON.parse(text) : null;
  }

  function buildRelevantStorageBundle(entries, options) {
    const files = {};
    const rejected = [];
    for (const entry of entries) {
      const parsed = parseStoragePath(entry.path, options);
      if (!parsed || !siteHostMatchesPage(parsed.siteHost, options.currentUrl)) {
        rejected.push(entry.path);
        continue;
      }
      files[parsed.canonicalPath] = {
        text: entry.text,
        scope: parsed.scope,
        siteHost: parsed.siteHost,
        sitePath: parsed.sitePath,
        originalPath: entry.path,
        size: entry.size ?? entry.text.length,
        lastModified: entry.lastModified ?? null,
      };
    }
    return {
      protocol: "actions.json.storage.browser-bundle",
      version: "0.1.0",
      currentUrl: options.currentUrl,
      pageHost: new URL(options.currentUrl).hostname,
      fileCount: Object.keys(files).length,
      files,
      rejected,
    };
  }

  function formatStorageDiagnostics({
    currentUrl,
    selectedFolderName,
    folderRead = null,
    bundle = null,
    message = null,
  }) {
    const url = new URL(currentUrl);
    const probe = relevantStorageProbePaths(currentUrl);
    const lines = [
      `Bookmarklet version: ${BOOKMARKLET_VERSION}`,
      `Storage key: ${STORAGE_KEY}`,
      `Current host: ${url.hostname}`,
      `Host candidates: ${probe.hosts.join(", ")}`,
    ];
    if (selectedFolderName) {
      lines.push(`Selected folder: ${selectedFolderName}`);
    }
    if (message) {
      lines.push("", message);
    }
    if (folderRead) {
      lines.push("", `Folder read mode: ${folderRead.mode || "root"}`);
      if (folderRead.selectedSitePrefix) {
        lines.push(`Selected-site prefix: ${folderRead.selectedSitePrefix}`);
      }
      lines.push(`Entries read: ${folderRead.entriesRead ?? 0}`);
      lines.push("Probe log:");
      for (const item of folderRead.probes || []) {
        const count =
          item.fileCount === undefined || item.fileCount === null ? "" : ` (${item.fileCount} file(s))`;
        lines.push(`  ${formatProbeStatus(item.status)} ${item.path}${count}`);
      }
      for (const error of folderRead.errors || []) {
        lines.push(`  ERROR ${error.path}: ${error.message}`);
      }
    }
    if (!bundle) {
      lines.push("", "No bundle stored for this browser origin.");
    } else {
      lines.push(
        "",
        `Stored bundle: ${bundle.fileCount} file(s)`,
        `Page host: ${bundle.pageHost}`,
        `Rejected: ${(bundle.rejected || []).length}`,
        "",
        ...Object.keys(bundle.files || {}).sort(),
      );
    }
    return lines.join("\n");
  }

  function formatProbeStatus(status) {
    if (status === "found") return "FOUND ";
    if (status === "error") return "ERROR ";
    return "missing";
  }

  function parseStoragePath(inputPath, options = {}) {
    const parts = String(inputPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const scopesIndex = parts.indexOf("scopes");
    if (scopesIndex >= 0) {
      return parseScopedParts(parts.slice(scopesIndex + 1));
    }
    const repoScope = scopeFromRepoFolder(parts[0]);
    if (repoScope) {
      const sitesIndex = parts.indexOf("sites");
      if (sitesIndex >= 0) return parseSiteParts(repoScope, parts.slice(sitesIndex));
    }
    if (parts[0] === "private" || parts[0] === "public") return parseSiteParts(parts[0], parts.slice(1));
    if (parts[0] === "shared" && parts[1]) return parseSiteParts(`shared:${parts[1]}`, parts.slice(2));
    if (parts[0] === "sites") return parseSiteParts(options.defaultScope || "private", parts);
    return null;
  }

  function parseScopedParts(parts) {
    if (parts[0] === "private" || parts[0] === "public") return parseSiteParts(parts[0], parts.slice(1));
    if (parts[0] === "shared" && parts[1]) return parseSiteParts(`shared:${parts[1]}`, parts.slice(2));
    return null;
  }

  function parseSiteParts(scope, parts) {
    if (parts[0] !== "sites" || !parts[1] || parts.length < 3) return null;
    const siteHost = parts[1].toLowerCase();
    const sitePath = parts.slice(2).join("/");
    return { scope, siteHost, sitePath, canonicalPath: canonicalPathFor(scope, siteHost, sitePath) };
  }

  function canonicalPathFor(scope, siteHost, sitePath) {
    if (scope.startsWith("shared:")) {
      return `scopes/shared/${scope.slice("shared:".length)}/sites/${siteHost}/${sitePath}`;
    }
    return `scopes/${scope}/sites/${siteHost}/${sitePath}`;
  }

  function scopeFromRepoFolder(folder) {
    if (folder === "actions.json.storage.private") return "private";
    if (folder === "actions.json.storage.public") return "public";
    const sharedPrefix = "actions.json.storage.shared.";
    if (String(folder || "").startsWith(sharedPrefix)) return `shared:${folder.slice(sharedPrefix.length)}`;
    return null;
  }

  function siteHostMatchesPage(siteHost, pageUrl) {
    const normalizedSite = String(siteHost || "").toLowerCase();
    const host = new URL(pageUrl).hostname.toLowerCase();
    const candidates = host.startsWith("www.") ? [host, host.slice(4)] : [host];
    return candidates.some((candidate) => candidate === normalizedSite || candidate.endsWith(`.${normalizedSite}`));
  }

  function loadBundle() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  async function requireStorageDirectoryHandle() {
    if (storageDirectoryHandle) {
      return storageDirectoryHandle;
    }
    if (!("showDirectoryPicker" in window)) {
      throw new Error("Folder access is not supported in this browser");
    }
    storageDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    return storageDirectoryHandle;
  }

  async function readDirectoryEntries(directoryHandle, prefix = "") {
    const entries = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        entries.push(...(await readDirectoryEntries(handle, path)));
        continue;
      }
      if (handle.kind !== "file") {
        continue;
      }
      const file = await handle.getFile();
      entries.push({
        path,
        text: await file.text(),
        size: file.size,
        lastModified: file.lastModified,
      });
    }
    return entries;
  }

  async function readRelevantDirectoryEntries(rootHandle, options) {
    const siteFolderPrefix = selectedSiteFolderPrefix(rootHandle.name, options.currentUrl, options.defaultScope);
    const diagnostics = {
      mode: siteFolderPrefix ? "selected-site-folder" : "root",
      selectedSitePrefix: siteFolderPrefix,
      entriesRead: 0,
      probes: [],
      errors: [],
    };
    if (siteFolderPrefix) {
      const entries = await readDirectoryEntries(rootHandle, siteFolderPrefix);
      diagnostics.entriesRead = entries.length;
      diagnostics.probes.push({
        path: siteFolderPrefix,
        status: "found",
        fileCount: entries.length,
      });
      return { entries, diagnostics };
    }

    const probe = relevantStorageProbePaths(options.currentUrl);
    const entries = [];
    const seen = new Set();

    for (const parts of probe.rootScopeSitePaths) {
      await readDirectoryIfPresent(rootHandle, parts, entries, seen, diagnostics);
    }

    await readSharedScopeSiteEntries(rootHandle, probe.hosts, entries, seen, diagnostics);

    for (const parts of probe.selectedScopeSitePaths) {
      await readDirectoryIfPresent(rootHandle, parts, entries, seen, diagnostics);
    }

    diagnostics.entriesRead = entries.length;
    return { entries, diagnostics };
  }

  function relevantStorageProbePaths(url) {
    const hosts = hostCandidatesFromUrl(url);
    return {
      rootScopeSitePaths: hosts.flatMap((host) => [
        ["scopes", "private", "sites", host],
        ["scopes", "public", "sites", host],
      ]),
      selectedScopeSitePaths: hosts.map((host) => ["sites", host]),
      hosts,
    };
  }

  function hostCandidatesFromUrl(url) {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? [host, host.slice(4)] : [host];
  }

  function selectedSiteFolderPrefix(folderName, url, scope) {
    const normalized = String(folderName || "").toLowerCase();
    if (!hostCandidatesFromUrl(url).includes(normalized)) {
      return null;
    }
    if (scope.startsWith("shared:")) {
      return `scopes/shared/${scope.slice("shared:".length)}/sites/${normalized}`;
    }
    return `scopes/${scope}/sites/${normalized}`;
  }

  async function readSharedScopeSiteEntries(rootHandle, hosts, entries, seen, diagnostics) {
    const sharedRoot = await getDirectoryIfPresent(rootHandle, ["scopes", "shared"], diagnostics);
    if (!sharedRoot) {
      return;
    }
    for await (const [audience, audienceHandle] of sharedRoot.entries()) {
      if (audienceHandle.kind !== "directory") {
        continue;
      }
      for (const host of hosts) {
        await readDirectoryIfPresent(
          rootHandle,
          ["scopes", "shared", audience, "sites", host],
          entries,
          seen,
          diagnostics,
        );
      }
    }
  }

  async function readDirectoryIfPresent(rootHandle, parts, entries, seen, diagnostics) {
    const prefix = parts.join("/");
    const directory = await getDirectoryIfPresent(rootHandle, parts, diagnostics);
    if (!directory) {
      return;
    }
    if (seen.has(prefix)) {
      return;
    }
    seen.add(prefix);
    const readEntries = await readDirectoryEntries(directory, prefix);
    entries.push(...readEntries);
    diagnostics.probes.push({
      path: prefix,
      status: "found",
      fileCount: readEntries.length,
    });
  }

  async function getDirectoryIfPresent(rootHandle, parts, diagnostics) {
    let current = rootHandle;
    const path = parts.join("/");
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part);
      } catch (error) {
        if (error.name === "NotFoundError") {
          diagnostics?.probes.push({
            path,
            status: "missing",
          });
          return null;
        }
        diagnostics?.probes.push({
          path,
          status: "error",
        });
        diagnostics?.errors.push({
          path,
          message: `${error.name || "Error"}: ${error.message}`,
        });
        throw error;
      }
    }
    return current;
  }

  function writeTargetsForBundle(bundle) {
    const targets = [];
    for (const [filePath, file] of Object.entries(bundle?.files || {})) {
      assertSafeCanonicalPath(filePath);
      targets.push({
        path: filePath,
        parts: filePath.split("/"),
        text: String(file.text ?? ""),
      });
    }
    return targets;
  }

  function assertSafeCanonicalPath(filePath) {
    const parts = String(filePath || "").split("/");
    if (parts.length < 5 || parts[0] !== "scopes") {
      throw new Error(`Unsafe storage path: ${filePath}`);
    }
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Unsafe storage path: ${filePath}`);
    }
  }

  async function writeTextAtPath(rootHandle, parts, text) {
    const fileName = parts.at(-1);
    const directoryParts = parts.slice(0, -1);
    let directory = rootHandle;
    for (const part of directoryParts) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
  }

  function writePartsForSelectedFolder(target, selectedSitePrefix) {
    if (!selectedSitePrefix) {
      return target.parts;
    }
    const prefix = selectedSitePrefix.split("/");
    const matchesPrefix = prefix.every((part, index) => target.parts[index] === part);
    if (!matchesPrefix) {
      return target.parts;
    }
    const relativeParts = target.parts.slice(prefix.length);
    if (relativeParts.length === 0) {
      throw new Error(`Unsafe storage path: ${target.path}`);
    }
    return relativeParts;
  }
})();
