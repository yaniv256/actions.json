import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, 'live', 'locator-actionability-smoke.mjs'),
  'utf8',
);

assert.match(
  source,
  /headless:\s*true/,
  'the smoke must not depend on an interactive WSL display',
);
assert.match(
  source,
  /channel:\s*['"]chromium['"]/,
  'headless extension smoke must opt into the Chromium channel',
);
assert.match(
  source,
  /ignoreDefaultArgs:\s*\[\s*['"]--disable-extensions['"]\s*\]/,
  'the smoke must remove Playwright\'s default flag that disables every extension',
);
assert.match(
  source,
  /launchPersistentContext\([\s\S]*?timeout:\s*\d+/,
  'persistent-context launch must have a bounded timeout',
);
assert.match(
  source,
  /withTimeout\(context\.close\(\),\s*['"]Chromium context close['"]\)/,
  'browser cleanup must be bounded',
);
assert.match(
  source,
  /withTimeout\(closeServer\(server\),\s*['"]fixture server close['"]\)/,
  'fixture-server cleanup must be awaited and bounded',
);
assert.match(
  source,
  /chrome-extension:\/\/\$\{extensionId\}\/src\/options\.html/,
  'privileged evaluations must use a stable extension-owned page',
);
assert.doesNotMatch(
  source,
  /worker\.evaluate\(/,
  'the smoke must not dispatch through a suspendable MV3 service worker',
);
assert.match(
  source,
  /withTimeout\([\s\S]*?content runtime injection/,
  'extension dispatch phases must be bounded independently',
);

console.log('locator actionability smoke lifecycle contract passed');
