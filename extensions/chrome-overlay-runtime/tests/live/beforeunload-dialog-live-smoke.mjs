import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeAuthHeaders, requireBridgeSecret } from "./support/bridge-secret.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const REPO = path.resolve(EXT, "../..");
const BRIDGE_BIN = path.join(REPO, "mcp/target/debug/actions-json-mcp");
const BRIDGE_PORT = 17407;
const CDP_PORT = 17408;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  async waitForEvent(method, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((event) => event.method === method);
      if (index >= 0) return this.events.splice(index, 1)[0].params;
      await sleep(25);
    }
    throw new Error(`timed out waiting for CDP event ${method}`);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function waitForTarget(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const target = targets.find(predicate);
      if (target) return target;
    } catch { /* Chrome warming */ }
    await sleep(100);
  }
  throw new Error("timed out waiting for CDP target");
}

async function waitForBrowserClient(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      if (version.webSocketDebuggerUrl) return new CdpClient(version.webSocketDebuggerUrl);
    } catch { /* Chrome warming */ }
    await sleep(100);
  }
  throw new Error("timed out waiting for browser-level CDP");
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function waitForExtensionWorker(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    } catch { /* Chrome warming */ }
    for (const target of targets.filter((item) => item.type === "service_worker")) {
      const client = new CdpClient(target.webSocketDebuggerUrl);
      try {
        await client.send("Runtime.enable");
        const ownsRuntime = await evaluate(client,
          "Boolean(globalThis.chrome?.tabs?.create && globalThis.__claimTest?.claim)");
        if (ownsRuntime) {
          console.log("extension worker:", target.url);
          return client;
        }
      } catch { /* not our extension worker */ }
      client.close();
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for the actions.json extension worker");
}

// U12b: /mcp/tools/call requires the per-installation handshake secret. Resolved
// eagerly in main() from the same .actions-json.local.json the spawned bridge
// reads, so a missing secret fails by name instead of as an opaque 401.
let bridgeSecret = null;

async function callTool(name, args, runtimeId, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/mcp/tools/call`, {
      method: "POST",
      headers: bridgeAuthHeaders(bridgeSecret, { "content-type": "application/json" }),
      body: JSON.stringify({ name, arguments: args, target_runtime_id: runtimeId }),
      signal: controller.signal,
    });
    const body = await response.json();
    console.log(`${name} response:`, JSON.stringify(body));
    if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body.output?.value ?? body.output ?? body.error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForRuntimes(count, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/runtimes`);
      const body = await response.json();
      if (body.count === count) return body.runtimes;
    } catch { /* bridge warming */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${count} runtimes`);
}

async function main() {
  bridgeSecret = requireBridgeSecret(); // before Chrome: cheap failure, named cause
  if (!fs.existsSync(BRIDGE_BIN)) {
    throw new Error(`bridge binary missing: ${BRIDGE_BIN}`);
  }
  execFileSync("node", [path.join(EXT, "esbuild.a11y.mjs")], { stdio: "inherit" });

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beforeunload-store-"));
  const bridge = spawn(BRIDGE_BIN, [
    "serve", "--bind", `127.0.0.1:${BRIDGE_PORT}`, "--storage-root", storageRoot,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  bridge.stdout.on("data", (data) => process.stdout.write(`[bridge] ${data}`));
  bridge.stderr.on("data", (data) => process.stderr.write(`[bridge] ${data}`));

  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "beforeunload-tls-"));
  const tlsKey = path.join(tlsDir, "key.pem");
  const tlsCert = path.join(tlsDir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", tlsKey, "-out", tlsCert,
  ], { stdio: "ignore" });
  const server = https.createServer({
    key: fs.readFileSync(tlsKey),
    cert: fs.readFileSync(tlsCert),
  }, (request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/away") {
      response.end("<!doctype html><title>Away</title><h1 id=away>away</h1>");
      return;
    }
    response.end(`<!doctype html><title>${request.url}</title>
      <button id=dirty>Make dirty</button><output id=status>clean</output>
      <script>
        dirty.addEventListener('click', () => {
          addEventListener('beforeunload', (event) => {
            event.preventDefault();
            event.returnValue = '';
          });
          document.querySelector('#status').textContent = 'dirty';
        }, { once: true });
      </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `https://127.0.0.1:${server.address().port}`;
  const wsBridge = `ws://127.0.0.1:${BRIDGE_PORT}/extension`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "beforeunload-profile-"));
  const chrome = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stdout.on("data", (data) => process.stdout.write(`[chrome] ${data}`));
  chrome.stderr.on("data", (data) => process.stderr.write(`[chrome] ${data}`));
  let workerClient = null;
  let browserClient = null;
  const pageClients = [];

  try {
    browserClient = await waitForBrowserClient();
    workerClient = await waitForExtensionWorker();

    const armBeforeUnload = async (tab) => {
      const readyDeadline = Date.now() + 5000;
      while (Date.now() < readyDeadline) {
        if (await evaluate(tab.pageClient, "Boolean(document.querySelector('#dirty'))")) break;
        await sleep(50);
      }
      await browserClient.send("Target.activateTarget", { targetId: tab.targetId });
      await evaluate(workerClient, `chrome.tabs.update(${tab.id}, { active: true }); true`);
      await tab.pageClient.send("Page.bringToFront");
      await evaluate(tab.pageClient, "document.querySelector('#dirty').focus(); true");
      await tab.pageClient.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      });
      await tab.pageClient.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      });
      const activationDeadline = Date.now() + 2000;
      let activated = false;
      while (Date.now() < activationDeadline) {
        activated = await evaluate(tab.pageClient, "navigator.userActivation.hasBeenActive");
        if (activated) break;
        await sleep(25);
      }
      if (!activated) throw new Error(`trusted input did not activate ${tab.suffix} fixture`);
      await evaluate(tab.pageClient, "document.querySelector('#dirty').click(); true");
      const dirtyDeadline = Date.now() + 2000;
      let status = null;
      while (Date.now() < dirtyDeadline) {
        status = await evaluate(tab.pageClient, "document.querySelector('#status')?.textContent");
        if (status === "dirty") break;
        await sleep(25);
      }
      if (status !== "dirty") throw new Error(`failed to arm ${tab.suffix} fixture: ${status}`);
    };

    const tabs = [];
    for (const suffix of ["/survivor", "/dialog"]) {
      const tab = await evaluate(workerClient, `(async () => {
        const tab = await chrome.tabs.create({ url: ${JSON.stringify(`${base}${suffix}`)}, active: true });
        return { id: tab.id, url: tab.url };
      })()`);
      const pageTarget = await waitForTarget((target) => target.type === "page" && target.url.endsWith(suffix));
      const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
      pageClients.push(pageClient);
      await pageClient.send("Page.enable");
      await pageClient.send("Runtime.enable");
      const entry = { id: tab.id, suffix, pageClient, targetId: pageTarget.id };
      tabs.push(entry);
      if (suffix === "/dialog") await armBeforeUnload(entry);
    }

    for (const tab of tabs) {
      const claim = await evaluate(workerClient,
        `self.__claimTest.claim(${tab.id}, ${JSON.stringify(wsBridge)})`);
      if (!claim.ok) throw new Error(`claim failed: ${JSON.stringify(claim)}`);
    }

    const runtimes = await waitForRuntimes(2);
    const runtimeFor = (suffix) => runtimes.find((runtime) => runtime.url?.endsWith(suffix));
    const dialogRuntime = runtimeFor("/dialog");
    if (!dialogRuntime) throw new Error(`runtime identity mismatch: ${JSON.stringify(runtimes)}`);

    const refusal = await callTool("browser.close_tab", {}, dialogRuntime.runtime_id);
    if (refusal?.code !== "beforeunload_guard_detected" || refusal?.closed !== false) {
      throw new Error(`close_tab did not refuse the guarded tab: ${JSON.stringify(refusal)}`);
    }
    const dialogTab = tabs.find((tab) => tab.suffix === "/dialog");
    const dialogTabId = dialogTab.id;
    const stillOpen = await evaluate(workerClient,
      `(async () => (await chrome.tabs.query({})).some((tab) => tab.id === ${dialogTabId}))()`);
    if (!stillOpen) throw new Error("guarded tab closed despite default refusal");

    dialogTab.pageClient.close();
    dialogTab.pageClient = null;

    const triggerBeforeUnload = async () => {
      await evaluate(workerClient,
        `chrome.tabs.update(${dialogTabId}, { url: ${JSON.stringify(`${base}/away`)} }); true`);
      const deadline = Date.now() + 3000;
      let state = null;
      while (Date.now() < deadline) {
        state = await evaluate(workerClient, `(async () => {
          const tab = await chrome.tabs.get(${dialogTabId});
          return { url: tab.url, pendingUrl: tab.pendingUrl || null, status: tab.status };
        })()`);
        if (state.pendingUrl?.endsWith("/away")) return state;
        await sleep(25);
      }
      throw new Error(`beforeunload navigation did not enter a blocked state: ${JSON.stringify(state)}`);
    };

    await triggerBeforeUnload();
    const cancelled = await callTool("browser.dismiss_dialog", { accept: false }, dialogRuntime.runtime_id);
    if (cancelled?.dismissed !== true || cancelled?.accept !== false) {
      const state = await evaluate(workerClient, `(async () => {
        const tab = await chrome.tabs.get(${dialogTabId});
        return { url: tab.url, pendingUrl: tab.pendingUrl || null, status: tab.status };
      })()`);
      throw new Error(`Cancel/Stay recovery failed: ${JSON.stringify({ cancelled, state })}`);
    }
    await sleep(300);
    const cancelledUrl = await evaluate(workerClient, `(async () => (await chrome.tabs.get(${dialogTabId})).url)()`);
    if (!cancelledUrl.endsWith("/dialog")) {
      throw new Error(`Cancel/Stay navigated away unexpectedly: ${cancelledUrl}`);
    }

    // Successful dismissal deliberately releases the debugger session. Exercise
    // the public safety gate again to prove it can re-arm recovery for a later
    // prompt on the same guarded document.
    const rearmedRefusal = await callTool("browser.close_tab", {}, dialogRuntime.runtime_id);
    if (
      rearmedRefusal?.code !== "beforeunload_guard_detected" ||
      rearmedRefusal?.dialog_recovery_armed !== true
    ) {
      throw new Error(`close_tab did not re-arm dialog recovery: ${JSON.stringify(rearmedRefusal)}`);
    }

    await triggerBeforeUnload();
    const accepted = await callTool("browser.dismiss_dialog", { accept: true }, dialogRuntime.runtime_id);
    if (accepted?.dismissed !== true || accepted?.accept !== true) {
      throw new Error(`Leave recovery failed: ${JSON.stringify(accepted)}`);
    }
    const deadline = Date.now() + 5000;
    let acceptedUrl = null;
    while (Date.now() < deadline) {
      acceptedUrl = await evaluate(workerClient, `(async () => (await chrome.tabs.get(${dialogTabId})).url)()`);
      if (acceptedUrl.endsWith("/away")) break;
      await sleep(50);
    }
    if (!acceptedUrl?.endsWith("/away")) {
      throw new Error(`Leave did not complete navigation: ${acceptedUrl}`);
    }

    await evaluate(workerClient,
      `chrome.tabs.update(${dialogTabId}, { url: ${JSON.stringify(`${base}/dialog`)}, active: true }); true`);
    const rearmedTarget = await waitForTarget(
      (target) => target.type === "page" && target.url.endsWith("/dialog"),
    );
    dialogTab.targetId = rearmedTarget.id;
    dialogTab.pageClient = new CdpClient(rearmedTarget.webSocketDebuggerUrl);
    pageClients.push(dialogTab.pageClient);
    await dialogTab.pageClient.send("Page.enable");
    await dialogTab.pageClient.send("Runtime.enable");
    await armBeforeUnload(dialogTab);
    dialogTab.pageClient.close();
    dialogTab.pageClient = null;
    const reconnectedRuntimes = await waitForRuntimes(2);
    const reconnectedDialogRuntime = reconnectedRuntimes.find(
      (runtime) => runtime.url?.endsWith("/dialog"),
    );
    if (!reconnectedDialogRuntime) {
      throw new Error(`reloaded dialog runtime missing: ${JSON.stringify(reconnectedRuntimes)}`);
    }
    const forced = await callTool(
      "browser.close_tab",
      { force: true },
      reconnectedDialogRuntime.runtime_id,
    );
    if (forced?.closed !== true || forced?.forced !== true) {
      throw new Error(`force close did not report success: ${JSON.stringify(forced)}`);
    }
    await sleep(300);
    const forceRemains = await evaluate(workerClient,
      `(async () => (await chrome.tabs.query({})).some((tab) => tab.id === ${dialogTabId}))()`);
    if (forceRemains) throw new Error("force close reported success but its Chrome tab remains open");
    await waitForRuntimes(1);

    console.log("LIVE BEFOREUNLOAD SAFETY SMOKE PASS ✓");
  } finally {
    for (const client of pageClients) client.close();
    browserClient?.close();
    workerClient?.close();
    chrome.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    bridge.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
