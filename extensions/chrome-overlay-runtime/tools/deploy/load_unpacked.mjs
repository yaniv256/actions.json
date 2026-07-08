// Native-Windows-Node CDP-over-pipe helper for Extensions.loadUnpacked.
//
// MUST run as a native Windows node process (node.exe), NOT WSL node: CDP-over-pipe
// needs Chrome to inherit debugging-pipe fds 3/4 from the spawning process, and WSL
// fds do not cross into a Windows chrome.exe ("Remote debugging pipe file descriptors
// are not open"). Native Windows node inherits them correctly via
// stdio:['inherit','inherit','inherit','pipe','pipe'] (child fd3 = our write, fd4 = read).
//
// Pipe framing: each CDP message is JSON terminated by a single NUL byte (\0).
// Extensions.loadUnpacked requires --enable-unsafe-extension-debugging and writes the
// unpacked extension into the profile's Secure Preferences (like "Load unpacked"), so a
// normally-launched Chrome on the SAME --user-data-dir then has it. Pipe and port are
// mutually exclusive, so this short-lived headless pipe-Chrome ONLY does the load.
//
// Usage (invoked by chrome_launcher.py via Windows node.exe):
//   node load_unpacked.mjs <chromeExe> <userDataDir> <extPath>
// Prints one JSON line: {"ok":true,"id","name","version"} or {"ok":false,"error"}.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_NAME = 'actions.json Overlay Runtime';
const [chromeExe, userDataDir, extPath] = process.argv.slice(2);

function output(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
// Hard-killing Chrome right after loadUnpacked leaves the extensions.settings entry
// on disk WITHOUT its protection MAC (Chrome flushes the signed Secure Preferences
// only on a clean shutdown), so the next Chrome launch scrubs the unsigned entry as
// tampered and never loads it. Root cause of the "install doesn't persist" bug.
// So on success we close GRACEFULLY (CDP Browser.close) and wait for exit, forcing
// Chrome to write the MAC. On failure we can hard-kill (nothing to persist).
function killHard(obj, child) { output(obj); try { child && child.kill(); } catch {} process.exit(obj.ok ? 0 : 1); }

if (!chromeExe || !userDataDir || !extPath) {
  finish({ ok: false, error: 'usage: load_unpacked.mjs <chromeExe> <userDataDir> <extPath>' });
}

const child = spawn(chromeExe, [
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
], { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] });

const pipeWrite = child.stdio[3];
const pipeRead = child.stdio[4];
let buf = Buffer.alloc(0);
let nextId = 0;
const pending = new Map();

pipeRead.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let nul;
  while ((nul = buf.indexOf(0)) !== -1) {
    const raw = buf.slice(0, nul).toString('utf8');
    buf = buf.slice(nul + 1);
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (d.id != null && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  }
});

const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId;
  pending.set(id, res);
  pipeWrite.write(JSON.stringify({ id, method, params }) + '\0');
});

child.on('error', (e) => killHard({ ok: false, stage: 'spawn', error: String(e && e.message || e) }, child));
const timer = setTimeout(() => killHard({ ok: false, stage: 'timeout' }, child), 30000);

setTimeout(async () => {
  try {
    const load = await send('Extensions.loadUnpacked', { path: extPath });
    if (load.error) { clearTimeout(timer); killHard({ ok: false, stage: 'loadUnpacked', error: load.error }, child); return; }
    const id = load.result && load.result.id;
    // Identity by manifest (KTD3): read the manifest we loaded; never trust an id prefix.
    let name = null, version = null;
    try { const m = JSON.parse(readFileSync(join(extPath, 'manifest.json'), 'utf8')); name = m.name; version = m.version; } catch (e) { name = null; version = 'manifest-read-error: ' + e.message; }
    clearTimeout(timer);
    const ok = name === EXPECTED_NAME;
    const result = { ok, id, name, version, ...(ok ? {} : { error: `manifest name mismatch: expected "${EXPECTED_NAME}" got ${JSON.stringify(name)}` }) };
    if (!ok) { killHard(result, child); return; }
    // SUCCESS: close gracefully so Chrome flushes the signed Secure Preferences (the
    // protection MAC) to disk — otherwise the next launch scrubs our entry as tampered.
    child.on('exit', () => { output(result); process.exit(0); });
    await send('Browser.close');
    setTimeout(() => { try { child.kill(); } catch {}; output(result); process.exit(0); }, 8000); // fallback if exit stalls
  } catch (e) {
    clearTimeout(timer); killHard({ ok: false, stage: 'exception', error: String(e && e.message || e) }, child);
  }
}, 1500);
