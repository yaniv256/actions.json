import { chromium } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const payload = Buffer.from("remote file transfer live proof\n", "utf8");
const sha256 = crypto.createHash("sha256").update(payload).digest("hex");

let server;
let context;
let tempDir;
try {
  server = http.createServer((request, response) => {
    if (request.url === "/payload.txt") {
      response.setHeader("content-type", "text/plain");
      response.end(payload);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><input id='attachment' type='file'><output id='proof'></output><script>attachment.addEventListener('change',()=>{proof.textContent=attachment.files[0]?.name+':'+attachment.files[0]?.size})</script>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-transfer-live-"));
  const extensionDir = path.join(tempDir, "extension");
  fs.cpSync(EXT, extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "test-controller.html"), "<!doctype html><title>file transfer controller</title>");

  context = await chromium.launchPersistentContext(path.join(tempDir, "profile"), {
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--no-first-run"],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${extensionId}/test-controller.html`);
  const page = await context.newPage();
  await page.goto(origin);
  const tabId = await controller.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${origin}/`);
  if (!Number.isInteger(tabId)) throw new Error("fixture tab not found");
  await controller.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["src/content.js"] }), tabId);

  const upload = await worker.evaluate(async ({ tabId, origin, size, sha256, base64 }) => {
    const call = (primitive, args) => self.__fileTransferTestCall(primitive, args);
    const created = await call("file.transfer.create", { transfer_id: "live-upload-proof", direction: "upload", filename: "proof.txt", mime_type: "text/plain", origin, expected_size: size, expected_sha256: sha256 });
    if (created?.result?.ok !== true) throw new Error(`create failed: ${JSON.stringify(created)}`);
    await call("file.transfer.chunk", { transfer_id: "live-upload-proof", index: 0, base64 });
    await call("file.transfer.finalize", { transfer_id: "live-upload-proof" });
    return chrome.tabs.sendMessage(tabId, {
      type: "actions-json:file-transfer-test",
      name: "file.transfer.upload.consume",
      arguments: { transfer_id: "live-upload-proof", origin, file_input: { selector: "#attachment" } },
    });
  }, { tabId, origin, size: payload.length, sha256, base64: payload.toString("base64") });
  if (upload?.ok !== true) throw new Error(`upload failed: ${JSON.stringify(upload)}`);
  await page.waitForFunction(() => document.querySelector("#proof")?.textContent === "proof.txt:32");

  const download = await worker.evaluate(({ tabId, origin }) => chrome.tabs.sendMessage(tabId, {
    type: "actions-json:file-transfer-test",
    name: "file.transfer.download.capture",
    arguments: { transfer_id: "live-download-proof", origin, url: `${origin}/payload.txt` },
  }), { tabId, origin });
  if (download?.ok !== true || download?.value?.sha256 !== sha256) throw new Error(`download capture failed: ${JSON.stringify(download)}`);
  const chunk = await worker.evaluate((args) => self.__fileTransferTestCall("file.transfer.download.read_chunk", args), { transfer_id: "live-download-proof", index: 0 });
  if (chunk?.result?.value?.base64 !== payload.toString("base64")) throw new Error(`download bytes mismatch: ${JSON.stringify(chunk)}`);
  await worker.evaluate((args) => self.__fileTransferTestCall("file.transfer.download.complete", args), { transfer_id: "live-download-proof" });
  console.log("REMOTE FILE TRANSFER LIVE SMOKE PASS ✓");
} finally {
  await context?.close().catch(() => {});
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
