// Injected into the a11y bundle alongside automation_globals.js.
// Fills the small non-automation chrome.* surface the fork touches that a
// standard extension lacks (audit: docs/a11y-shim-spec.md):
//  - chrome.accessibilityPrivate: getDisplayNameForLocale gets a REAL
//    implementation via Intl.DisplayNames; focus-ring calls are cosmetic no-ops.
//  - chrome.tts.getVoices / chrome.metricsPrivate: no-ops.
//  - chrome.i18n: real in the MV3 service worker; minimal fallback only when
//    absent (Node test harness).
const g = globalThis;
g.chrome = g.chrome || {};
const C = g.chrome;
if (!C.accessibilityPrivate) C.accessibilityPrivate = {};
const AP = C.accessibilityPrivate;
if (!AP.getDisplayNameForLocale) {
  AP.getDisplayNameForLocale = (locale, displayLocale) => {
    try { return new Intl.DisplayNames([displayLocale || 'en'], {type: 'language'}).of(locale) || ''; }
    catch { return ''; }
  };
}
if (!AP.setFocusRings) AP.setFocusRings = () => {};
if (!AP.setChromeVoxFocus) AP.setChromeVoxFocus = () => {};
if (!AP.FocusType) AP.FocusType = {GLOW: 'glow', SOLID: 'solid', DASHED: 'dashed'};
if (!AP.AssistiveTechnologyType) AP.AssistiveTechnologyType = {CHROME_VOX: 'chromeVox'};
if (!C.tts) C.tts = {};
if (!C.tts.getVoices) C.tts.getVoices = (cb) => { if (cb) cb([]); return Promise.resolve([]); };
if (!C.metricsPrivate) C.metricsPrivate = {recordBoolean: () => {}};
// ChromeVox message catalog: generated from the vendored
// strings/chromevox_strings.grdp (tools/gen-chromevox-messages.mjs) — the
// REAL English strings. The extension's own _locales never carries chromevox_*
// keys, so getMessage is wrapped: catalog first for chromevox_* ids ($1..$9
// substitution per chrome.i18n semantics), then whatever native i18n exists.
import CHROMEVOX_MESSAGES from './generated/chromevox_messages.json';
const substitute = (msg, subs) => {
  if (!subs) return msg;
  const arr = Array.isArray(subs) ? subs : [subs];
  return msg.replace(/\$(\d)/g, (_, n) => String(arr[Number(n) - 1] ?? ''));
};
if (!C.i18n) C.i18n = {getUILanguage: () => (g.navigator && g.navigator.language) || 'en-US'};
const nativeGetMessage = C.i18n.getMessage ? C.i18n.getMessage.bind(C.i18n) : () => '';
C.i18n.getMessage = (key, subs) => {
  const hit = CHROMEVOX_MESSAGES[key];
  if (hit !== undefined) return substitute(hit, subs);
  return nativeGetMessage(key, subs) || '';
};
export {};
