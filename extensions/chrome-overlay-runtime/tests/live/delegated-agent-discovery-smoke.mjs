// Real-extension smoke for U3 declarative website-agent discovery.
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/delegated-agent-discovery-smoke.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const PINNED = "https://github.com/example/course-agent/blob/0123456789abcdef0123456789abcdef01234567/agent.json";

function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForProposal(extensionPage, tabId, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await withTimeout(
      extensionPage.evaluate(
        (id) => chrome.runtime.sendMessage({ type: "actions-json:delegated-agent-proposals-list", tabId: id }),
        tabId,
      ),
      "delegated proposal query",
    );
    const proposal = response?.proposals?.[0] || null;
    if (predicate(proposal)) return proposal;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("proposal state timed out");
}

async function main() {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/frame") {
      response.end(`<!doctype html><link rel="actions-json-agent" href="${PINNED.replace("blob/0123456789abcdef0123456789abcdef01234567", "blob/main")}">`);
      return;
    }
    response.end(`<!doctype html><head><link id="agent" rel="actions-json-agent" href="${PINNED}"></head><body><h1>Course</h1><iframe src="/frame"></iframe></body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "delegated-discovery-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });
  console.log("browser launched");

  try {
    const initialPageCount = context.pages().length;
    const page = context.pages()[0] || await context.newPage();
    // The production background is event-driven and may remain asleep until the
    // document-start broker emits discovery. Navigate first, then observe the
    // service worker started by that message.
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    console.log("fixture loaded");
    assert.equal(context.pages().length, initialPageCount, "discovery never opens unsolicited trusted UI");

    const inspector = await context.newPage();
    await inspector.goto("chrome://extensions");
    console.log("extensions inspector loaded");
    await inspector.waitForTimeout(500);
    const extensionId = await inspector.evaluate(() => {
      const manager = document.querySelector("extensions-manager")?.shadowRoot;
      const list = manager?.querySelector("extensions-item-list")?.shadowRoot;
      const item = [...(list?.querySelectorAll("extensions-item") || [])]
        .find((candidate) => candidate.data?.name === "actions.json Overlay Runtime");
      return item?.data?.id || null;
    });
    await inspector.close();
    console.log("extension id", extensionId);
    assert.equal(typeof extensionId, "string");
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
    console.log("extension popup loaded");
    const tabId = await withTimeout(
      extensionPage.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
      }, url),
      "popup chrome.tabs.query",
    );
    assert.equal(Number.isInteger(tabId), true);

    const valid = await waitForProposal(extensionPage, tabId, (record) => record?.state === "unapproved");
    assert.equal(valid.proposal.repository.commitSha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(valid.proposal.source.frameId, 0, "iframe declaration cannot replace top-level authority");
    assert.equal(await extensionPage.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), "A");

    await page.evaluate(() => {
      document.getElementById("agent").href = "https://github.com/example/course-agent/blob/main/agent.json";
    });
    const invalid = await waitForProposal(extensionPage, tabId, (record) => record?.state === "invalid");
    assert.match(invalid.error, /commit|blob/i);
    assert.equal(await extensionPage.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), "!");
    console.log(JSON.stringify({ tabId, validState: valid.state, invalidState: invalid.state }, null, 2));
    console.log("DELEGATED DISCOVERY LIVE SMOKE PASS ✓");
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
