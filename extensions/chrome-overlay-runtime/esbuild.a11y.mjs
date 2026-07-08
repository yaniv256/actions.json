// U2: bundles the ChromeVox policy core (third_party/chromevox, unmodified)
// with the Tier-B stub seams into a single MV3-service-worker-loadable module.
// Spec: docs/a11y-shim-spec.md. Invoke: node extensions/chrome-overlay-runtime/esbuild.a11y.mjs
import * as esbuild from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FORK = path.join(REPO, 'third_party/chromevox');
const A11Y = path.join(HERE, 'src/a11y');
const STUBS = path.join(A11Y, 'stubs');

// Tier-B seam map: resolved fork path -> stub (docs/a11y-shim-spec.md §3).
const rel = (p) => path.join(FORK, p);
const SEAMS = new Map([
  [rel('chromevox/mv3/background/tts_interface.ts'), 'tts_interface.js'],
  [rel('chromevox/mv3/background/abstract_earcons.ts'), 'abstract_earcons.js'],
  [rel('chromevox/mv3/background/math_handler.ts'), 'math_handler.js'],
  [rel('chromevox/mv3/background/phonetic_data.js'), 'phonetic_data.js'],
  [rel('chromevox/mv3/background/event_source.ts'), 'event_source.js'],
  [rel('chromevox/mv3/background/event/desktop_automation_interface.ts'), 'desktop_automation_interface.js'],
  [rel('chromevox/mv3/background/logging/log_store.ts'), 'log_store.js'],
  [rel('chromevox/mv3/background/braille/braille_command_handler.ts'), 'braille_command_handler.js'],
  [rel('chromevox/mv3/background/braille/braille_interface.ts'), 'braille_interface.js'],
  [rel('chromevox/mv3/background/braille/spans.ts'), 'spans.js'],
  [rel('chromevox/mv3/common/settings_manager.ts'), 'settings_manager.js'],
  [rel('chromevox/mv3/common/bridge_constants.ts'), 'bridge_constants.js'],
  [rel('chromevox/mv3/common/braille/braille_key_types.ts'), 'braille_key_types.js'],
  [rel('chromevox/mv3/common/braille/nav_braille.ts'), 'nav_braille.js'],
  [rel('common/bridge_helper.ts'), 'bridge_helper.js'],
  [rel('common/local_storage.ts'), 'local_storage.js'],
]);

const forkResolver = {
  name: 'chromevox-fork-resolver',
  setup(build) {
    // Rooted messageformat rollup (build artifact) -> npm-backed adapter.
    build.onResolve({filter: /third_party\/messageformat\/messageformat\.rollup\.js$/}, () =>
      ({path: path.join(A11Y, 'messageformat_adapter.js')}));
    // Rooted fork imports: /common/... and /chromevox/...
    build.onResolve({filter: /^\/(common|chromevox)\//}, (args) => resolveFork(path.join(FORK, args.path)));
    // Relative imports inside the fork tree (so seams apply at every hop).
    build.onResolve({filter: /^\./}, (args) => {
      if (!args.importer.startsWith(FORK)) return undefined;
      return resolveFork(path.resolve(args.resolveDir, args.path));
    });
  },
};

function resolveFork(wanted) {
  const candidates = wanted.endsWith('.js')
    ? [wanted.slice(0, -3) + '.ts', wanted]
    : [wanted, wanted + '.ts', wanted + '.js'];
  for (const c of candidates) {
    if (SEAMS.has(c)) return {path: path.join(STUBS, SEAMS.get(c))};
  }
  for (const c of candidates) {
    try { if (require('node:fs').statSync(c).isFile()) return {path: c}; } catch {}
  }
  return {errors: [{text: `a11y bundle: unresolved fork import ${wanted} (no file, no Tier-B seam — see docs/a11y-shim-spec.md §3)`}]};
}
// esbuild plugins run in ESM here; provide require for statSync above.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

// Regenerate the ChromeVox message catalog from the vendored grdp first —
// chrome_polyfills.js imports it.
const {execFileSync} = await import('node:child_process');
execFileSync('node', [path.join(HERE, 'tools/gen-chromevox-messages.mjs')], {stdio: 'inherit'});

await esbuild.build({
  entryPoints: [path.join(A11Y, 'fork_entry.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(HERE, 'dist/a11y-bundle.js'),
  inject: [path.join(A11Y, 'automation_globals.js'), path.join(A11Y, 'chrome_polyfills.js')],
  plugins: [forkResolver],
  logLevel: 'info',
});
console.log('a11y bundle built.');
