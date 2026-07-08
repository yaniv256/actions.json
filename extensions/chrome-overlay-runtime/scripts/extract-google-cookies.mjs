// Populate the eval harness's gitignored Google-cookies secret from YOUR OWN logged-in
// Chrome — one way to give the portable harness (tests/live/eval/) an authenticated
// session without checking any account into the repo.
//
// It opens a real Chrome/Chromium window; you sign into Google (or it reuses an existing
// login), then it captures the google.com cookies and writes them to the secret file the
// harness reads (default tests/live/eval/eval-secrets.cookies.json, gitignored).
//
// Run: node extensions/chrome-overlay-runtime/scripts/extract-google-cookies.mjs
//   env: EVAL_COOKIES_FILE (output path), CHROME_CHANNEL (e.g. 'chrome' to use your
//        installed Chrome instead of Playwright's Chromium), HEADFUL_SECONDS (login wait).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.EVAL_COOKIES_FILE
  || path.resolve(HERE, '../tests/live/eval/eval-secrets.cookies.json');
const WAIT = Number(process.env.HEADFUL_SECONDS || 120);

async function main() {
  const ctx = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gcookie-')),
    { headless: false, channel: process.env.CHROME_CHANNEL || undefined },
  );
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://accounts.google.com/');
  console.log(`Sign into the Google account you want the eval harness to use.`);
  console.log(`Waiting ${WAIT}s for you to finish, then capturing cookies…`);
  await page.waitForTimeout(WAIT * 1000);

  const all = await ctx.cookies();
  const google = all.filter((c) => /google\.com$/.test(c.domain.replace(/^\./, '')));
  if (!google.length) { console.error('No google.com cookies captured — did you sign in?'); process.exit(1); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), cookies: google }, null, 2));
  console.log(`Wrote ${google.length} google.com cookies to ${OUT} (gitignored).`);
  await ctx.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
