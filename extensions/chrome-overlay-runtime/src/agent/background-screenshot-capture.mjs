const normalizeError = (error, fallback) => ({
  code: error?.code || fallback,
  message: error?.message || String(error || fallback),
});

const positiveLimit = (value) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

const bytesToDataUrl = async (blob, mimeType) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
};

// Native background screenshots can exceed the hosted bridge payload budget.
// Compact only when bounds are requested; the dependency seam keeps this
// behavior deterministic in unit tests and uses MV3 globals in production.
export async function compactScreenshotDataUrl(dataUrl, options = {}, dependencies = {}) {
  const maxWidth = positiveLimit(options.maxWidth);
  const maxHeight = positiveLimit(options.maxHeight);
  const maxKilobytes = positiveLimit(options.maxKilobytes);
  if (!maxWidth && !maxHeight && !maxKilobytes) return { dataUrl, compacted: false };

  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const bitmapFactory = dependencies.bitmapFactory || globalThis.createImageBitmap;
  const canvasFactory = dependencies.canvasFactory
    || (typeof OffscreenCanvas === "function" ? ((width, height) => new OffscreenCanvas(width, height)) : null);
  if (typeof fetchImpl !== "function" || typeof bitmapFactory !== "function" || typeof canvasFactory !== "function") {
    return { dataUrl, compacted: false, warning: "image_compaction_unavailable" };
  }

  const sourceBlob = await (await fetchImpl(dataUrl)).blob();
  const bitmap = await bitmapFactory(sourceBlob);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  let scale = Math.min(1, maxWidth ? maxWidth / sourceWidth : 1, maxHeight ? maxHeight / sourceHeight : 1);
  let quality = Number.isInteger(options.quality) ? Math.max(1, Math.min(100, options.quality)) / 100 : 0.75;
  const mimeType = options.format === "jpeg" ? "image/jpeg" : "image/png";
  let outputBlob = sourceBlob;
  let outputWidth = sourceWidth;
  let outputHeight = sourceHeight;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    outputWidth = Math.max(1, Math.round(sourceWidth * scale));
    outputHeight = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = canvasFactory(outputWidth, outputHeight);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, outputWidth, outputHeight);
    outputBlob = await canvas.convertToBlob({ type: mimeType, quality });
    if (!maxKilobytes || outputBlob.size <= maxKilobytes * 1024) break;
    scale *= 0.82;
    quality = Math.max(0.2, quality * 0.8);
  }

  const compacted = outputWidth !== sourceWidth || outputHeight !== sourceHeight || outputBlob.size !== sourceBlob.size;
  return {
    dataUrl: compacted ? await bytesToDataUrl(outputBlob, mimeType) : dataUrl,
    compacted,
    source_width: sourceWidth,
    source_height: sourceHeight,
    output_width: outputWidth,
    output_height: outputHeight,
    output_bytes: outputBlob.size,
    max_kilobytes: maxKilobytes,
  };
}

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
    const capturedDataUrl = await browser.captureVisibleTab(windowId, {
      format: options.format === "jpeg" ? "jpeg" : "png",
      quality: Number.isInteger(options.quality) ? options.quality : undefined,
    });
    if (typeof capturedDataUrl !== "string" || !capturedDataUrl.startsWith("data:image/")) {
      throw new Error("captureVisibleTab returned no image data");
    }
    const compacted = await compactScreenshotDataUrl(capturedDataUrl, options);
    return {
      ok: true,
      dataUrl: compacted.dataUrl,
      surface_identity: "verified_active_tab",
      freshness: "unverified",
      delay_ms_applied: delayMs,
      ...(compacted.compacted || compacted.warning ? { screenshot_compaction: compacted } : {}),
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error, "screenshot_capture_failed") };
  }
}
