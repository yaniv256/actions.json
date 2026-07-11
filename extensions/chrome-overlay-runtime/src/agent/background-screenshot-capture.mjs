const normalizeError = (error, fallback) => ({
  code: error?.code || fallback,
  message: error?.message || String(error || fallback),
});

const chromeCallback = (chromeApi, invoke, code) => new Promise((resolve, reject) => {
  invoke((value) => {
    const error = chromeApi.runtime?.lastError;
    if (error) reject({ code, message: error.message || String(error) });
    else resolve(value);
  });
});

export function createChromeScreenshotBrowser(
  chromeApi,
  { delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  return {
    focusWindow(windowId) {
      if (!chromeApi.windows?.update) {
        return Promise.reject({
          code: "screenshot_window_focus_failed",
          message: "chrome.windows.update is unavailable",
        });
      }
      return chromeCallback(
        chromeApi,
        (callback) => chromeApi.windows.update(windowId, { focused: true }, callback),
        "screenshot_window_focus_failed",
      );
    },
    activateTab(tabId) {
      return chromeCallback(
        chromeApi,
        (callback) => chromeApi.tabs.update(tabId, { active: true }, callback),
        "screenshot_target_activation_failed",
      );
    },
    readActiveTab(windowId) {
      return chromeCallback(
        chromeApi,
        (callback) => chromeApi.tabs.query({ active: true, windowId }, (tabs) => callback(tabs?.[0] || null)),
        "screenshot_active_tab_read_failed",
      );
    },
    delay: delayFn,
    captureVisibleTab(windowId, options) {
      return chromeCallback(
        chromeApi,
        (callback) => chromeApi.tabs.captureVisibleTab(windowId, options, callback),
        "screenshot_capture_failed",
      );
    },
  };
}

export async function captureTabSurface(browser, tab, options = {}) {
  const tabId = Number(tab?.id);
  const windowId = Number(tab?.windowId);
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    return {
      ok: false,
      error: {
        code: "screenshot_target_invalid",
        message: "Screenshot capture requires an identified tab and window.",
      },
    };
  }

  try {
    await browser.focusWindow(windowId);
  } catch (error) {
    return { ok: false, error: normalizeError(error, "screenshot_window_focus_failed") };
  }

  try {
    await browser.activateTab(tabId);
  } catch (error) {
    return { ok: false, error: normalizeError(error, "screenshot_target_activation_failed") };
  }

  let activeTab;
  try {
    activeTab = await browser.readActiveTab(windowId);
  } catch (error) {
    return { ok: false, error: normalizeError(error, "screenshot_active_tab_read_failed") };
  }
  if (Number(activeTab?.id) !== tabId) {
    return {
      ok: false,
      error: {
        code: "screenshot_target_not_active",
        message: `Screenshot target tab ${tabId} is not the active tab in window ${windowId}.`,
        target_tab_id: tabId,
        active_tab_id: Number.isInteger(Number(activeTab?.id)) ? Number(activeTab.id) : null,
      },
    };
  }

  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, Math.min(30_000, Math.floor(options.delayMs)))
    : 0;
  if (delayMs > 0) {
    await browser.delay(delayMs);
  }

  try {
    const dataUrl = await browser.captureVisibleTab(windowId, {
      format: options.format === "jpeg" ? "jpeg" : "png",
      quality: Number.isInteger(options.quality) ? options.quality : undefined,
    });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      throw new Error("captureVisibleTab returned no image data");
    }
    return {
      ok: true,
      dataUrl,
      surface_identity: "verified_active_tab",
      freshness: "unverified",
      delay_ms_applied: delayMs,
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error, "screenshot_capture_failed") };
  }
}
