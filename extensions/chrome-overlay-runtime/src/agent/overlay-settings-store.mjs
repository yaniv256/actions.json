export const OVERLAY_SETTINGS_STORAGE_KEY = "ACTIONS_JSON_OVERLAY_SETTINGS_V1";

export const OVERLAY_RESTING_CORNERS = Object.freeze([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

export const OVERLAY_REDUCED_MOTION_MODES = Object.freeze(["system", "reduce", "full"]);

export const DEFAULT_OVERLAY_SETTINGS = Object.freeze({
  showCost: false,
  devMode: false,
  restingCorner: "bottom-right",
  reducedMotion: "system",
});

// Strict on purpose: a settings value that arrives as "false" or 0 is a caller
// bug, not a preference. Coercing it would silently flip a user-visible toggle,
// so every field throws and names itself instead.
function normalizeBoolean(source, field) {
  const value = source[field];
  if (value == null) return DEFAULT_OVERLAY_SETTINGS[field];
  if (typeof value !== "boolean") {
    throw new Error(`Overlay setting ${field} must be a boolean, received ${typeof value}.`);
  }
  return value;
}

function normalizeEnum(source, field, allowed) {
  const value = source[field];
  if (value == null) return DEFAULT_OVERLAY_SETTINGS[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Overlay setting ${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

export function normalizeOverlaySettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    showCost: normalizeBoolean(source, "showCost"),
    devMode: normalizeBoolean(source, "devMode"),
    restingCorner: normalizeEnum(source, "restingCorner", OVERLAY_RESTING_CORNERS),
    reducedMotion: normalizeEnum(source, "reducedMotion", OVERLAY_REDUCED_MOTION_MODES),
  };
}

/**
 * Should the overlay's cost-meter footer be visible?
 *
 * content.js is not a module and cannot import this, so it repeats the rule
 * inline against the same storage key. This function is the definition that
 * rule must match, and it exists so the decision is testable at all: the
 * shipped gate is a `footer.hidden` assignment buried in a DOM helper.
 *
 * Strict `=== true`: a settings blob that arrives from storage half-written, or
 * with showCost absent, must resolve to HIDDEN. Defaulting a spend readout to
 * visible is the failure that matters — it is a privacy surprise on a shared
 * screen, and the user never asked for it.
 */
export function shouldShowCostMeter(settings) {
  return settings?.showCost === true;
}

export async function getOverlaySettings(storage) {
  const stored = await storage.get(OVERLAY_SETTINGS_STORAGE_KEY);
  return normalizeOverlaySettings(stored?.[OVERLAY_SETTINGS_STORAGE_KEY]);
}

export async function saveOverlaySettings(storage, settings) {
  const normalized = normalizeOverlaySettings(settings);
  await storage.set({ [OVERLAY_SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}
