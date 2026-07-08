// EVAL auth-secret unit tests (no browser): loadEvalCookies reads the developer-supplied
// gitignored cookies file, throws loudly when absent (so a run can't silently proceed
// unauthenticated), and normalizes to Playwright's addCookies shape.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEvalCookies, MissingCookiesError } from './live/eval/harness-env.mjs';

test('throws MissingCookiesError when the secret file is absent', () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'evalck-')), 'nope.json');
  assert.throws(() => loadEvalCookies(missing), MissingCookiesError);
});

test('accepts a raw cookies array and normalizes defaults', () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'evalck-')), 'c.json');
  writeFileSync(f, JSON.stringify([{ name: 'SID', value: 'abc' }]));
  const [c] = loadEvalCookies(f);
  assert.equal(c.name, 'SID');
  assert.equal(c.value, 'abc');
  assert.equal(c.domain, '.google.com'); // default
  assert.equal(c.path, '/');
  assert.equal(c.secure, true);
});

test('accepts the { cookies: [...] } wrapper shape and preserves explicit fields', () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'evalck-')), 'c.json');
  writeFileSync(f, JSON.stringify({ capturedAt: 'x', cookies: [
    { name: 'HSID', value: 'z', domain: '.google.com', path: '/', httpOnly: true, secure: true, sameSite: 'None', expires: 1893456000 },
  ] }));
  const [c] = loadEvalCookies(f);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'None');
  assert.equal(c.expires, 1893456000);
});

test('rejects an empty cookies array (would silently fail auth)', () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'evalck-')), 'c.json');
  writeFileSync(f, JSON.stringify({ cookies: [] }));
  assert.throws(() => loadEvalCookies(f), /non-empty/);
});
