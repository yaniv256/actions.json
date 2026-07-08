// Generates the ChromeVox English message catalog from the vendored
// strings/chromevox_strings.grdp (the Chromium source of truth; the built
// _locales/*.json.gz are build artifacts we don't have). Key scheme matches
// Msgs: IDS_CHROMEVOX_ROLE_STATUS -> chromevox_role_status.
// Output: src/a11y/generated/chromevox_messages.json (gitignored; rebuilt by
// esbuild.a11y.mjs).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRDP = path.resolve(HERE, '../../../third_party/chromevox/strings/chromevox_strings.grdp');
const OUT = path.resolve(HERE, '../src/a11y/generated/chromevox_messages.json');

const xml = fs.readFileSync(GRDP, 'utf8');
const catalog = {};
const msgRe = /<message[^>]*name="(IDS_CHROMEVOX_[A-Z0-9_]+)"[^>]*>([\s\S]*?)<\/message>/g;
let m;
while ((m = msgRe.exec(xml))) {
  const key = m[1].replace(/^IDS_/, '').toLowerCase();
  let body = m[2];
  body = body.replace(/<ph[^>]*>([\s\S]*?)<\/ph>/g, (_, inner) => inner.replace(/<ex>[\s\S]*?<\/ex>/g, ''));
  body = body.replace(/<ex>[\s\S]*?<\/ex>/g, '');
  body = body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  body = body.replace(/\s+/g, ' ').trim();
  catalog[key] = body;
}
fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, JSON.stringify(catalog));
console.log(`chromevox messages catalog: ${Object.keys(catalog).length} entries`);
