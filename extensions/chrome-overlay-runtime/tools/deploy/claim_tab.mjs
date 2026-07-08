// Native-Windows-Node headless tab-claim: make the self-installed extension take
// control of a target tab with NO human popup click. Codifies the proven recipe
// (see the memory / investigations note): the extension is inert until a tab is
// claimed, and the MV3 service worker sleeps — poking it directly over CDP fails
// (`-32001 Session with given id not found`, it unloads between attach and eval).
//
// THE TRICK: open the extension's OWN popup.html as a real tab. That (a) wakes the
// dormant SW and (b) gives a page context with `chrome.runtime`/`chrome.tabs` that
// HOLDS the SW alive via the open message port — exactly what a human's popup click
// provides. From that popup context we send the real `authorize-tab` message at the
// target tab id, which runs claimAuthorizedTab -> connectClaimedTab and opens the
// bridge WS from the content script.
//
// Usage (invoked by chrome_launcher.py via Windows node.exe):
//   node claim_tab.mjs <cdpWsUrl> <extensionId> <targetUrlContains> <bridgeUrl>
// Prints one JSON line: {"ok":true, tabId, response} or {"ok":false, error}.
import WebSocket from 'ws';

const [cdpWsUrl, extId, targetUrlContains, bridgeUrlArg] = process.argv.slice(2);
const BRIDGE = bridgeUrlArg || 'ws://100.99.150.49:17345/extension';

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
if (!cdpWsUrl || !extId || !targetUrlContains) {
  out({ ok: false, error: 'usage: claim_tab.mjs <cdpWsUrl> <extensionId> <targetUrlContains> [bridgeUrl]' });
  process.exit(1);
}

const ws = new WebSocket(cdpWsUrl);
let id = 0;
const pend = new Map();
const attached = new Map(); // targetId -> sessionId (flatten auto-attach)
ws.on('message', (x) => {
  let d; try { d = JSON.parse(x.toString()); } catch { return; }
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Target.attachedToTarget') attached.set(d.params.targetInfo.targetId, d.params.sessionId);
});
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const i = ++id; pend.set(i, r);
  const o = { id: i, method, params }; if (sessionId) o.sessionId = sessionId;
  ws.send(JSON.stringify(o));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (o) => { out({ ok: false, ...o }); try { ws.close(); } catch {} process.exit(1); };
setTimeout(() => fail({ stage: 'timeout' }), 30000);

ws.on('error', (e) => fail({ stage: 'ws', error: String(e && e.message || e) }));
ws.on('open', async () => {
  try {
    // Open the extension's popup page as a real tab. Target.createTarget opens a tab
    // whose page context has chrome.runtime; keeping it open holds the SW alive.
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const created = await send('Target.createTarget', { url: popupUrl });
    const popupTargetId = created.result?.targetId;
    if (!popupTargetId) return fail({ stage: 'open-popup', error: created.error || 'no targetId' });

    // Attach to the popup page to eval in its context.
    const at = await send('Target.attachToTarget', { targetId: popupTargetId, flatten: true });
    const sid = at.result?.sessionId;
    if (!sid) return fail({ stage: 'attach-popup', error: at.error || 'no sessionId' });
    await send('Runtime.enable', {}, sid);

    const evalPopup = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
      if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails) };
      return r.result?.result?.value;
    };

    // POLL for the popup's extension APIs to be ready — over the relay, popup.js + the
    // chrome.tabs API can take a while to inject; a fixed 600ms sleep raced it and
    // `chrome.tabs.query` threw "cannot read undefined". Wait until chrome.tabs exists.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const has = await evalPopup(`(typeof chrome !== 'undefined' && !!(chrome.tabs && chrome.runtime && chrome.storage))`);
      if (has === true) { ready = true; break; }
      await sleep(400);
    }
    if (!ready) return fail({ stage: 'popup-not-ready', error: 'chrome.tabs/runtime/storage never became available in the popup page' });

    // From the popup context: find the target tab, store bridgeUrl, send authorize-tab.
    const raw = await evalPopup(`(async()=>{
      try {
        const tabs = await chrome.tabs.query({});
        const needle = ${JSON.stringify(targetUrlContains)};
        const target = tabs.find(t => (t.url||'').includes(needle));
        if (!target) return JSON.stringify({ ok:false, error:'no tab matching '+needle, tabs: tabs.map(t=>({id:t.id,u:(t.url||'').slice(0,50)})) });
        const bridgeUrl = ${JSON.stringify(BRIDGE)};
        await chrome.storage.local.set({ bridgeUrl });
        const response = await chrome.runtime.sendMessage({ type:'actions-json:authorize-tab', tabId: target.id, bridgeUrl });
        return JSON.stringify({ ok: !!(response && response.ok), tabId: target.id, bridgeUrl, response });
      } catch (e) { return JSON.stringify({ ok:false, error: String(e && e.message || e) }); }
    })()`);
    if (raw && raw.__err) return fail({ stage: 'eval', error: raw.__err });
    const result = JSON.parse(raw);
    // Leave the popup tab OPEN — closing it lets the SW sleep and can drop the bridge.
    out(result);
    try { ws.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    fail({ stage: 'exception', error: String(e && e.message || e) });
  }
});
