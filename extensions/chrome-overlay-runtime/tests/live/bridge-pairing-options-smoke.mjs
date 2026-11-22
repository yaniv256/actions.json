import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "../..");
// A typed passphrase, shorter than a generated secret: 0.1.271 wrongly required 32+.
const TEST_SECRET = "quiet-fox9";
// A fake bridge: the extension preflights GET /extension/auth-check before it opens
// the WebSocket, so the fixture must answer that route the way the real bridge does.
const httpServer = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname !== "/extension/auth-check") {
    response.writeHead(404).end();
    return;
  }
  const authorized = url.searchParams.get("secret") === TEST_SECRET;
  response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
  response.end(JSON.stringify(authorized
    ? { authorized: true }
    : { authorized: false, error: { code: "handshake_secret_mismatch" } }));
});
const server = new WebSocketServer({ server: httpServer });
await new Promise((resolve, reject) => {
  httpServer.once("listening", resolve);
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1");
});
const stopServer = async () => {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
};
const bridgePort = httpServer.address().port;
const BRIDGE_URL = `ws://127.0.0.1:${bridgePort}/extension`;

const context = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pairing-options-")),
  {
    headless: true,
    channel: "chromium",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
    ],
  },
);

try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const firstRunDeadline = Date.now() + 10_000;
  let firstRunPage = null;
  while (!firstRunPage && Date.now() < firstRunDeadline) {
    firstRunPage = context.pages().find(
      (candidate) => candidate.url() === `chrome-extension://${extensionId}/src/options.html`,
    );
    if (!firstRunPage) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!firstRunPage) {
    throw new Error("fresh install did not open the guided options page");
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options.html`);
  const bridgeTop = await page.locator("h2", { hasText: "Bridge pairing" }).evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const hostedTop = await page.locator("h2", { hasText: "Hosted agent and storage" }).evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  if (bridgeTop >= hostedTop) {
    throw new Error("guided bridge pairing must appear before advanced hosted-agent settings");
  }

  await page.locator("#bridgeUrl").fill(BRIDGE_URL);
  await page.locator("#bridgeHandshakeSecret").fill(TEST_SECRET);
  await page.locator("#save-bridge-pairing").click();
  await page.waitForFunction(
    () => document.querySelector("#bridge-pairing-status")?.textContent?.includes("Coding agent connected"),
  );

  const stored = await page.evaluate(() => chrome.storage.local.get([
    "bridgeHandshakeSecret",
    "bridgeUrl",
  ]));
  if (stored.bridgeUrl !== BRIDGE_URL) {
    throw new Error("pairing UI did not persist the submitted bridge URL");
  }
  if (stored.bridgeHandshakeSecret !== TEST_SECRET) {
    throw new Error("pairing UI did not persist the submitted secret");
  }
  if ((await page.locator("#bridgeHandshakeSecret").inputValue()) !== "") {
    throw new Error("a successful connection should clear the submitted secret");
  }
  if ((await page.locator("#bridge-pairing-status").textContent()).includes(TEST_SECRET)) {
    throw new Error("pairing status exposed the secret");
  }
  const successfulLog = await page.locator("#bridge-connection-log").innerText();
  if (!successfulLog.includes("connected") || !successfulLog.includes(BRIDGE_URL)) {
    throw new Error(`successful bridge connection was not visible in the log: ${successfulLog}`);
  }
  if (successfulLog.includes(TEST_SECRET)) {
    throw new Error("connection log exposed the bridge secret");
  }

  await stopServer();
  await page.locator("#bridgeUrl").fill(BRIDGE_URL);
  await page.locator("#bridgeHandshakeSecret").fill(TEST_SECRET);
  await page.locator("#save-bridge-pairing").click();
  await page.waitForFunction(
    () => document.querySelector("#bridge-pairing-status")?.classList.contains("err"),
  );
  const failedLog = await page.locator("#bridge-connection-log").innerText();
  // With the bridge down, the HTTP authorization preflight fails before any WebSocket opens.
  if (!failedLog.includes("failed") || !(failedLog.includes("WebSocket failed to open") || failedLog.includes("could not verify"))) {
    throw new Error(`failed bridge connection was not visible in the log: ${failedLog}`);
  }
  if ((await page.locator("#bridgeHandshakeSecret").inputValue()) !== TEST_SECRET) {
    throw new Error("a refused connection should keep the input available for correction");
  }
  if (failedLog.includes(TEST_SECRET)) {
    throw new Error("failed connection log exposed the bridge secret");
  }

  await page.reload();
  if ((await page.locator("#bridgeHandshakeSecret").inputValue()) !== "") {
    throw new Error("the saved secret was echoed back into the input after reload");
  }
  await page.getByText("A bridge secret is saved on this browser.").waitFor();

  await page.locator("#remove-bridge-pairing").click();
  const removed = await page.evaluate(
    () => chrome.storage.local.get("bridgeHandshakeSecret"),
  );
  if (removed.bridgeHandshakeSecret) {
    throw new Error("Remove secret did not clear extension-local storage");
  }

  console.log("BRIDGE PAIRING OPTIONS LIVE SMOKE PASS");
} finally {
  if (httpServer.listening) await stopServer().catch(() => {});
  await context.close();
}
