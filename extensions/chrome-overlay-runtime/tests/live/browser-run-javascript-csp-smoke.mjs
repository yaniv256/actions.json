// Live regression for the Manifest V3 content-script CSP failure. Loads the
// unpacked extension into real Chromium, opens a page with a restrictive CSP,
// and proves browser.run_javascript's production evaluator reaches the page
// through chrome.debugger with truthful execution metadata.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/browser-run-javascript-csp-smoke.mjs
import { chromium } from "@playwright/test";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.setHeader("content-security-policy", "script-src 'self'");
    response.end("<!doctype html><title>CSP probe</title><main><h1>Debugger path</h1></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "actions-json-csp-smoke-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });

  let passed = false;
  try {
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    worker.on("console", (message) => console.log("[sw]", message.type(), message.text()));
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    console.log("CSP fixture loaded:", url);

    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, url);
    if (tabId == null) throw new Error("CSP fixture tab was not visible to the extension");
    console.log("CSP fixture tabId:", tabId);

    await worker.evaluate(({ id }) => self.__claimTest.inject(id), { id: tabId });
    console.log("evaluating through content action dispatch and the extension debugger transport");
    const result = await worker.evaluate(
      ({ id }) => chrome.tabs.sendMessage(id, {
        type: "actions-json:execute-action",
        call_id: "csp-live-browser-run-javascript",
        name: "browser.run_javascript",
        arguments: {
          source: `
            const { normalizeText, isElementVisible, queryRelative } = helpers;
            const main = document.querySelector("main");
            return {
              heading: document.querySelector("h1")?.textContent,
              normalized: normalizeText("  debugger   path  "),
              visible: isElementVisible(main),
              matches: queryRelative(main, "h1").length
            };
          `,
          args: {},
        },
      }),
      { id: tabId },
    );
    console.log("browser.run_javascript live result:", JSON.stringify(result));
    passed = result?.ok === true
      && result?.output?.result?.heading === "Debugger path"
      && result?.output?.result?.normalized === "debugger path"
      && result?.output?.result?.visible === true
      && result?.output?.result?.matches === 1
      && result?.output?.execution?.capability_class === "debug"
      && result?.output?.execution?.transport === "chrome.debugger";
    console.log(passed ? "CSP LIVE SMOKE PASS ✓" : "CSP LIVE SMOKE FAIL ✗");
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
