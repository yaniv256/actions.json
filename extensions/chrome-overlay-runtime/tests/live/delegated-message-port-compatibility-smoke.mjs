// Real-Chromium compatibility spike for the empowered website-agent transport.
// Proves an MV3 isolated content script can transfer a MessagePort to the page,
// keep JavaScript globals isolated, close the port on pagehide, and establish a
// fresh private port after a BFCache pageshow restoration.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/delegated-message-port-compatibility-smoke.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "fixtures/delegated-message-port-extension");

const pageScript = `
  window.__DELEGATED_MAIN_SECRET__ = "main-only";
  window.__delegatedPortProbe = {
    handshakes: 0,
    pageShows: [],
    pageHides: [],
    receivedIsolatedPing: false,
    receivedIsolatedPong: false,
    pageSeesIsolatedSecret: typeof window.__DELEGATED_ISOLATED_SECRET__,
  };
  let activePort = null;
  window.addEventListener("message", (event) => {
    if (
      event.source !== window
      || event.origin !== location.origin
      || event.data?.type !== "actions-json:delegated-port-probe"
      || event.ports.length !== 1
    ) return;
    activePort?.close();
    const { nonce, generation } = event.data;
    activePort = event.ports[0];
    window.__delegatedPortProbe.handshakes += 1;
    activePort.onmessage = (portEvent) => {
      const envelope = portEvent.data;
      if (envelope?.nonce !== nonce || envelope?.generation !== generation) return;
      if (envelope.type === "isolated-ping") {
        window.__delegatedPortProbe.receivedIsolatedPing = true;
        activePort.postMessage({ type: "page-pong", nonce, generation, sequence: envelope.sequence });
      } else if (envelope.type === "isolated-pong") {
        window.__delegatedPortProbe.receivedIsolatedPong = true;
      }
    };
    activePort.start();
    activePort.postMessage({ type: "page-ping", nonce, generation, sequence: 2 });
  });
  window.addEventListener("pageshow", (event) => {
    window.__delegatedPortProbe.pageShows.push({ persisted: event.persisted });
  });
  window.addEventListener("pagehide", (event) => {
    window.__delegatedPortProbe.pageHides.push({ persisted: event.persisted });
  });
`;

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === "/page.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(pageScript);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Delegated port probe</title><h1>Delegated port probe</h1><script src=/page.js></script>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "delegated-port-probe-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });

  try {
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = context.pages()[0] || await context.newPage();
    page.on("console", (message) => console.log("[page]", message.type(), message.text()));
    page.on("pageerror", (error) => console.log("[pageerror]", error.message));
    worker.on("console", (message) => console.log("[worker]", message.type(), message.text()));
    await page.goto(`${origin}/one`, { waitUntil: "load", timeout: 15_000 });
    await page.waitForFunction(() => (
      window.__delegatedPortProbe?.handshakes === 1
      && window.__delegatedPortProbe.receivedIsolatedPing
      && window.__delegatedPortProbe.receivedIsolatedPong
    ));
    const initial = await page.evaluate(() => structuredClone(window.__delegatedPortProbe));
    assert.equal(initial.pageSeesIsolatedSecret, "undefined");

    await page.goto(`${origin}/two`, { waitUntil: "load", timeout: 15_000 });
    await page.waitForFunction(() => window.__delegatedPortProbe?.handshakes === 1);
    // BFCache restoration does not dispatch a new load event; waiting for
    // "load" would make a successful restoration look like a timeout.
    await page.goBack({ waitUntil: "commit", timeout: 15_000 });
    await page.waitForFunction(() => (
      window.__delegatedPortProbe?.handshakes >= 2
      && window.__delegatedPortProbe.pageShows.some((event) => event.persisted)
      && window.__delegatedPortProbe.receivedIsolatedPing
      && window.__delegatedPortProbe.receivedIsolatedPong
    ));

    const restored = await page.evaluate(() => structuredClone(window.__delegatedPortProbe));
    const events = await worker.evaluate(() => self.__delegatedPortProbeEvents());
    const restoredTransfer = events.some((event) => event.name === "port-transferred" && event.reason === "bfcache-restore");
    const isolatedSeparation = events
      .filter((event) => event.name === "broker-installed" || event.name === "port-transferred")
      .every((event) => event.isolatedSeesMainSecret === "undefined");
    assert.equal(restored.pageShows.some((event) => event.persisted), true);
    assert.equal(restored.pageHides.some((event) => event.persisted), true);
    assert.equal(restoredTransfer, true);
    assert.equal(isolatedSeparation, true);
    const authorityEvents = events.filter((event) => (
      event.name === "broker-installed"
      || event.name === "port-transferred"
      || event.name === "page-ping-received"
      || event.name === "page-pong-received"
    ));
    assert.equal(authorityEvents.every((event) => event.sender.frameId === 0), true);
    assert.equal(events.every((event) => typeof event.sender.documentId === "string"), true);
    console.log(JSON.stringify({ initial, restored, eventCount: events.length, restoredTransfer }, null, 2));
    console.log("DELEGATED MESSAGEPORT COMPATIBILITY PASS ✓");
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
