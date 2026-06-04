import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bookmarkletDir = join(here, "..", "bookmarklet");

test("bookmarklet installer contains a draggable bookmarklet link", () => {
  const url = readFileSync(join(bookmarkletDir, "storage-bookmarklet.url"), "utf8").trim();
  const html = readFileSync(join(bookmarkletDir, "install.html"), "utf8");

  assert.match(url, /^javascript:/);
  assert.match(html, /<a\b[^>]*>actions\.json<\/a>/);
  assert.equal(html.includes(">actions.json.storage</a>"), false);
  assert.match(html, /rel="icon"/);
  assert.equal(html.includes(`href="${escapeHtml(url)}"`), true);
});

test("generated bookmarklet URL stays small enough for reliable bookmark installation", () => {
  const url = readFileSync(join(bookmarkletDir, "storage-bookmarklet.url"), "utf8").trim();

  assert.match(url, /^javascript:/);
  assert.ok(
    url.length < 75_000,
    `bookmarklet URL is ${url.length} characters; large bookmarklets are prone to browser truncation/corruption`,
  );
});

test("storage bookmarklet script exposes the release version for diagnostics", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /BOOKMARKLET_VERSION = "0\.1\.37"/);
});

test("storage bookmarklet uses the short actions.json name and keeps only the folder-backed controls", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /"aria-label": "actions\.json bookmarklet"/);
  assert.equal(source.includes("shadow.innerHTML"), false);
  assert.equal(source.includes("template.innerHTML"), false);
  assert.equal(source.includes("insertAdjacentHTML"), false);
  assert.match(source, /document\.createElement\("style"\)/);
  assert.match(source, /style\.textContent = shellCss/);
  assert.match(source, /shadow\.append\(style, buildShell\(\)\)/);
  assert.match(source, /function buildShell\(\)/);
  assert.match(source, /function createNode\(tagName/);
  assert.match(source, /node\.setAttribute\(name, value\)/);
  assert.equal(source.includes("<h1>"), false);
  assert.equal(source.includes("<h1>actions.json.storage</h1>"), false);
  assert.match(source, /Choose storage folder/);
  assert.match(source, /Load from folder/);
  assert.match(source, /Write to folder/);
  assert.match(source, /Clear local bundle/);
  assert.equal(source.includes("Import relevant folder"), false);
  assert.equal(source.includes("Export local bundle"), false);
  assert.equal(source.includes("Default scope for bare"), false);
});

test("storage bookmarklet panel can be collapsed, dragged, and resized", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /data-collapse/);
  assert.match(source, /toggleCollapsed/);
  assert.match(source, /preCollapseFrame/);
  assert.match(source, /\.collapsed\.panel/);
  assert.match(source, /width: 32px/);
  assert.match(source, /background: transparent/);
  assert.equal(source.indexOf('"data-close": ""') < source.indexOf('"data-collapse": ""'), true);
  assert.match(source, /text: "☰"/);
  assert.match(source, /const buttonRect = shouldCollapse \? collapseButton\.getBoundingClientRect\(\) : null/);
  assert.match(source, /root\.style\.left = `\$\{buttonRect\.left\}px`/);
  assert.equal(
    source.indexOf("const buttonRect = shouldCollapse ? collapseButton.getBoundingClientRect() : null;") <
      source.indexOf('panel.classList.toggle("collapsed", collapsed);'),
    true,
  );
  assert.equal(
    source.indexOf('root.style.inset = "auto auto auto auto";') < source.indexOf("root.style.left = `${buttonRect.left}px`;"),
    true,
  );
  assert.equal(
    source.indexOf("root.style.inset = preCollapseFrame.inset;") < source.indexOf("root.style.left = preCollapseFrame.left;"),
    true,
  );
  assert.equal(
    source.lastIndexOf('root.style.inset = "auto auto auto auto";') < source.indexOf("root.style.left = `${rect.left}px`;"),
    true,
  );
  assert.equal(source.includes('root.style.right = "12px";'), false);
  assert.match(source, /startDrag/);
  assert.match(source, /collapseButton\.addEventListener\("pointerdown"/);
  assert.match(source, /startDrag\(event, { suppressClickOnMove: true }\)/);
  assert.match(source, /if \(event\.target\.closest\("button"\) && !collapsed\) return/);
  assert.match(source, /suppressNextCollapseClick/);
  assert.match(source, /setTimeout\(\(\) => {\s+suppressNextCollapseClick = false;\s+}, 250\)/);
  assert.match(source, /window\.innerWidth - rect\.width/);
  assert.match(source, /resize: both/);
  assert.match(source, /min-width/);
  assert.match(source, /min-height/);
});

test("storage bookmarklet exposes tabbed overlay and launcher helpers to stored actions", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /openTab\(tab\)/);
  assert.match(source, /installLaunchers\(overlayArgs = {}\)/);
  assert.match(source, /data-tabs/);
  assert.match(source, /data-tab-panels/);
  assert.match(source, /actionsJson:\s*{/);
  assert.match(source, /openTab,/);
  assert.match(source, /installLaunchers,/);
  assert.match(source, /actions-json:overlay-launcher-opened/);
  assert.match(source, /registerExistingTab\("actions-json", "actions\.json"\)/);
  assert.match(source, /registerExistingTab\("status", "Status"\)/);
  assert.match(source, /"data-tab-id": "actions-json"/);
  assert.match(source, /"data-tab-id": "status"/);
  assert.equal(source.indexOf('"data-tabs": ""') < source.indexOf('const controls = createNode("div", { className: "window-controls" }'), true);
  assert.equal(source.indexOf('"data-choose-folder": ""') > source.indexOf('"data-tab-id": "actions-json"'), true);
  assert.match(source, /\.tab-panel img/);
});

test("storage bookmarklet connects to the existing extension MCP websocket protocol", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /ws:\/\/127\.0\.0\.1:17345\/extension/);
  assert.match(source, /runtime_ready/);
  assert.match(source, /runtime_status/);
  assert.match(source, /action_call/);
  assert.match(source, /action_call_output/);
  assert.match(source, /action_error/);
  assert.match(source, /storage\.import_bundle/);
  assert.match(source, /storage\.list/);
});

test("storage bookmarklet exposes user-consented screenshot capture", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /name: "browser\.screenshot"/);
  assert.match(source, /navigator\.mediaDevices\.getDisplayMedia/);
  assert.match(source, /preferCurrentTab: true/);
  assert.match(source, /data-capture-screenshot/);
  assert.match(source, /capture_method: "getDisplayMedia"/);
  assert.equal(source.includes("captureDomViewport"), false);
  assert.equal(source.includes("bookmarklet_dom_foreign_object"), false);
});

test("storage bookmarklet executes JavaScript actions declared by loaded actions.json files", () => {
  const source = readFileSync(join(bookmarkletDir, "storage-bookmarklet.js"), "utf8");

  assert.match(source, /browser\.run_javascript/);
  assert.match(source, /loadStoredActionManifests/);
  assert.match(source, /executeStoredAction/);
  assert.match(source, /x_actions\?\.javascript/);
  assert.match(source, /new Function/);
});

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
