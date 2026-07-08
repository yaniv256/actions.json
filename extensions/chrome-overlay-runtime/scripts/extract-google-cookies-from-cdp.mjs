// Extract Google cookies from an ALREADY-RUNNING Chrome reachable over CDP — specifically the
// chrome-launcher MCP's visible Windows Chrome that Yaniv logs into (endpoint like
// ws://192.168.176.1:9223). The shipped extract-google-cookies.mjs launches its OWN Playwright
// Chromium and asks the user to log into THAT window — wrong browser for this flow. This one
// attaches (connectOverCDP) to the session the user actually authenticated in and pulls cookies.
//
// Usage:  CDP_WS='ws://192.168.176.1:9223/devtools/browser/<id>' \
//         node scripts/extract-google-cookies-from-cdp.mjs
// Writes the same gitignored file the harness reads (EVAL_COOKIES_FILE or the default).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.EVAL_COOKIES_FILE
  || path.resolve(HERE, '../tests/live/eval/eval-secrets.cookies.json');
const WS = process.env.CDP_WS;

if (!WS) {
  console.error('ERR: set CDP_WS to the browser webSocketDebuggerUrl (from chrome_endpoint).');
  process.exit(2);
}

async function main() {
  const browser = await chromium.connectOverCDP(WS);
  try {
    // Cookies live on the browser context(s). Pull from all contexts, then keep Google-auth ones.
    const contexts = browser.contexts();
    let all = [];
    for (const ctx of contexts) {
      const cs = await ctx.cookies().catch(() => []);
      all = all.concat(cs);
    }
    // Fallback: if the default context reported nothing, try a CDP session getAllCookies.
    if (!all.length && contexts[0]) {
      const page = contexts[0].pages()[0] || (await contexts[0].newPage());
      const client = await contexts[0].newCDPSession(page);
      const r = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
      all = r.cookies || [];
    }
    const google = all.filter((c) =>
      /google\.com$/.test(c.domain) ||
      /youtube\.com$/.test(c.domain) ||
      String(c.domain).includes('google'));
    if (!google.length) {
      console.error(`ERR: 0 Google cookies found (saw ${all.length} total). Is the session logged into Google? Open a Doc first.`);
      process.exit(3);
    }
    fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), cookies: google }, null, 2));
    console.log(`OK: wrote ${google.length} Google cookies to ${OUT}`);
    const names = new Set(google.map((c) => c.name));
    const key = ['SID', 'SSID', 'HSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'].filter((n) => names.has(n));
    console.log(`auth cookies present: ${key.join(', ') || '(none of the usual SID set — may not be fully authed)'}`);
  } finally {
    await browser.close().catch(() => {}); // connectOverCDP close only detaches; doesn't kill the window
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
