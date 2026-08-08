import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "acorn";

// `scripts/package-extension.sh` zips an EXPLICIT, hand-maintained list of files. Nothing checked
// that the list is complete, so adding a runtime module and forgetting the list ships a zip whose
// module graph cannot instantiate.
//
// That failure is silent and total: a static import of a file Chrome cannot find makes the MV3
// service worker REGISTER, run ZERO statements of its module body, and log NOTHING — no
// `Runtime.exceptionThrown`, no entry on chrome://extensions. The extension is simply inert.
//
// The actions-json-dev-cycle skill's release gate names this in step 3 ("New runtime FILES added to the
// change -> add them to the explicit list in scripts/package-extension.sh or the zip ships
// broken"). It is a rule you can read and then not do. So: check it.
//
// Found 2026-07-09: src/agent/realtime-model.mjs (added in fec9f4d to centralize DEFAULT_MODEL)
// was imported by src/background.js and absent from the zip list. 0.1.189 would have shipped
// with a background worker that never initializes.

const REPO = path.resolve(import.meta.dirname, "../..");
const EXT = path.join(REPO, "extensions/chrome-overlay-runtime");
const GENERATED_MODULES = new Set([
  "dist/a11y-bundle.js",
  "dist/protoface-broker-bundle.mjs",
  "dist/protoface-client-bundle.mjs",
]);
const MANIFEST = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const BACKGROUND_SOURCE = readFileSync(path.join(EXT, MANIFEST.background.service_worker), "utf8");

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, visit));
    else if (value && typeof value === "object") walkAst(value, visit);
  }
}

function memberPath(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type !== "MemberExpression" || node.computed) return null;
  const parent = memberPath(node.object);
  return parent && node.property?.type === "Identifier" ? `${parent}.${node.property.name}` : null;
}

function literalString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function runtimeHtmlPageEntryPoints(source) {
  const ast = parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const constants = new Map();
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.type !== "Identifier") continue;
      const value = literalString(declaration.init);
      if (value !== null) constants.set(declaration.id.name, value);
    }
  }
  const bindingCounts = new Map();
  const mutated = new Set();
  const countBinding = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      bindingCounts.set(pattern.name, (bindingCounts.get(pattern.name) || 0) + 1);
    } else if (pattern.type === "ObjectPattern") {
      pattern.properties.forEach((property) => countBinding(property.value ?? property.argument));
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach(countBinding);
    } else if (pattern.type === "RestElement") {
      countBinding(pattern.argument);
    } else if (pattern.type === "AssignmentPattern") {
      countBinding(pattern.left);
    }
  };
  const markMutation = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") mutated.add(pattern.name);
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach((property) => markMutation(property.value ?? property.argument));
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(markMutation);
    else if (pattern.type === "RestElement") markMutation(pattern.argument);
    else if (pattern.type === "AssignmentPattern") markMutation(pattern.left);
  };
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator") countBinding(node.id);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      countBinding(node.id);
      node.params.forEach(countBinding);
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") countBinding(node.id);
    if (node.type === "CatchClause") countBinding(node.param);
    if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") {
      countBinding(node.local);
    }
    if (node.type === "AssignmentExpression") markMutation(node.left);
    if (node.type === "UpdateExpression") markMutation(node.argument);
  });
  const pages = [];
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression" || memberPath(node.callee) !== "chrome.offscreen.createDocument") return;
    const options = node.arguments[0];
    if (options?.type !== "ObjectExpression") {
      throw new Error("unsupported non-literal chrome.offscreen.createDocument options");
    }
    const url = options.properties.find((property) => {
      const key = property.key?.name ?? property.key?.value;
      return property.type === "Property" && key === "url";
    });
    const identifier = url?.value?.type === "Identifier" ? url.value.name : null;
    const trustedConstant = identifier
      && bindingCounts.get(identifier) === 1
      && !mutated.has(identifier)
      ? constants.get(identifier)
      : null;
    const page = literalString(url?.value) ?? trustedConstant;
    if (!page) throw new Error("unsupported non-literal chrome.offscreen.createDocument url");
    const normalized = page.split(/[?#]/, 1)[0];
    if (!normalized.endsWith(".html")) throw new Error(`offscreen document is not HTML: ${page}`);
    pages.push(normalized);
  });
  return [...new Set(pages)];
}

const WEB_ACCESSIBLE_HTML_PAGES = (MANIFEST.web_accessible_resources || [])
  .flatMap((entry) => entry.resources || [])
  .filter((resource) => resource.endsWith(".html"));
const RUNTIME_HTML_PAGES = runtimeHtmlPageEntryPoints(BACKGROUND_SOURCE);
const MODULE_PAGES = [...new Set([
  MANIFEST.action?.default_popup,
  MANIFEST.options_ui?.page,
  ...WEB_ACCESSIBLE_HTML_PAGES,
  ...RUNTIME_HTML_PAGES,
].filter(Boolean))];

function moduleScriptsForPage(page) {
  const source = readFileSync(path.join(EXT, page), "utf8");
  const scripts = [];
  for (const [, attributes] of source.matchAll(/<script\b([^>]*)>/gi)) {
    const type = attributes.match(/\btype=["']([^"']+)["']/i)?.[1];
    const src = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (type !== "module" || !src) continue;
    scripts.push(path.relative(EXT, path.resolve(path.dirname(path.join(EXT, page)), src)));
  }
  return scripts;
}

const PAGE_MODULE_ENTRY_POINTS = MODULE_PAGES.flatMap(moduleScriptsForPage);

function injectedScriptEntryPoints(source) {
  const ast = parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const scripts = [];
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression" || memberPath(node.callee) !== "chrome.scripting.executeScript") return;
    const options = node.arguments[0];
    if (options?.type !== "ObjectExpression") {
      throw new Error("unsupported non-literal chrome.scripting.executeScript options");
    }
    const files = options.properties.find((property) => {
      const key = property.key?.name ?? property.key?.value;
      return property.type === "Property" && key === "files";
    });
    if (!files) return;
    if (files.value?.type !== "ArrayExpression") {
      throw new Error("unsupported non-literal chrome.scripting.executeScript files");
    }
    for (const element of files.value.elements) {
      const script = literalString(element);
      if (script === null) throw new Error("unsupported non-literal injected script path");
      scripts.push(script);
    }
  });
  return [...new Set(scripts)];
}

const INJECTED_SCRIPT_ENTRY_POINTS = injectedScriptEntryPoints(
  BACKGROUND_SOURCE,
);

// Everything Chrome loads as a module graph root. manifest.json's service_worker, plus each
// `<script type="module">` an extension page pulls in and every production-injected script.
const ENTRY_POINTS = [
  MANIFEST.background?.service_worker,
  ...PAGE_MODULE_ENTRY_POINTS,
  ...INJECTED_SCRIPT_ENTRY_POINTS,
].filter(Boolean);

function zippedFiles() {
  const sh = readFileSync(path.join(REPO, "scripts/package-extension.sh"), "utf8");
  // the `zip -q -r "$out" \` block lists one path per line, four-space indented, backslash-continued
  return new Set([...sh.matchAll(/^ {4}([\w./-]+\.(?:js|mjs|json|html|md))\s*\\?$/gm)].map((m) => m[1]));
}

function chromeRuntimeUrl(node) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 1) return null;
  const getUrl = node.callee;
  const runtime = getUrl?.type === "MemberExpression" && !getUrl.computed
    && getUrl.property?.name === "getURL" ? getUrl.object : null;
  const chrome = runtime?.type === "MemberExpression" && !runtime.computed
    && runtime.property?.name === "runtime" ? runtime.object : null;
  if (chrome?.type !== "Identifier" || chrome.name !== "chrome") return null;
  return literalString(node.arguments[0]);
}

function importedModuleSpecifiers(source) {
  const ast = parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const specs = [];
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration"
      || node.type === "ExportNamedDeclaration"
      || node.type === "ExportAllDeclaration") {
      const spec = literalString(node.source);
      if (spec !== null) specs.push({ spec, extensionRelative: false });
    } else if (node.type === "ImportExpression") {
      const literal = literalString(node.source);
      const extensionUrl = chromeRuntimeUrl(node.source);
      if (literal !== null) specs.push({ spec: literal, extensionRelative: false });
      if (extensionUrl !== null) specs.push({ spec: extensionUrl, extensionRelative: true });
      if (literal === null && extensionUrl === null) {
        throw new Error("unsupported non-literal dynamic import in extension module graph");
      }
    }
  });
  return specs;
}

function resolvedImportedModules(importer, source) {
  const importerAbs = path.join(EXT, importer);
  return importedModuleSpecifiers(source).flatMap(({ spec, extensionRelative }) => {
    if (!extensionRelative && !spec.startsWith(".")) {
      throw new Error(`unsupported bare module import in extension module graph: ${importer} -> ${spec}`);
    }
    const resolved = extensionRelative
      ? path.resolve(EXT, spec)
      : path.resolve(path.dirname(importerAbs), spec);
    const relative = path.relative(EXT, resolved);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`extension import escapes package root: ${importer} -> ${spec}`);
    }
    return [relative];
  });
}

// Resolve the transitive closure of relative static, side-effect, and literal dynamic imports,
// plus extension-root-relative import(chrome.runtime.getURL("...")) calls. A non-literal dynamic
// specifier cannot be packaged safely by the explicit inventory and is intentionally not guessed.
function reachableModules(entries) {
  const seen = new Set();
  const missingOnDisk = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const abs = path.join(EXT, rel);
    if (!existsSync(abs)) {
      if (GENERATED_MODULES.has(rel)) return;
      missingOnDisk.push(rel);
      return;
    }
    const source = readFileSync(abs, "utf8");
    for (const imported of resolvedImportedModules(rel, source)) walk(imported);
  };
  for (const entry of entries) walk(entry);
  return { seen, missingOnDisk };
}

test("module discovery covers every supported import form", () => {
  const specs = importedModuleSpecifiers(`
    import value from "./static-from.mjs";
    import "./side-effect.mjs";
    export { value as renamed } from "./re-export.mjs";
    const literal = import("./literal-dynamic.mjs");
    const extension = import(chrome.runtime.getURL("src/extension-dynamic.mjs"));
  `);
  assert.deepEqual(specs, [
    { spec: "./static-from.mjs", extensionRelative: false },
    { spec: "./side-effect.mjs", extensionRelative: false },
    { spec: "./re-export.mjs", extensionRelative: false },
    { spec: "./literal-dynamic.mjs", extensionRelative: false },
    { spec: "src/extension-dynamic.mjs", extensionRelative: true },
  ]);
});

test("every extension page module script is a package-graph entry point", () => {
  assert.deepEqual([...PAGE_MODULE_ENTRY_POINTS].sort(), [
    "src/agent-surface.js",
    "src/offscreen-agent.js",
    "src/options.js",
    "src/popup.js",
  ]);
});

test("manifest and runtime page loaders are package authorities", () => {
  assert.deepEqual([...MODULE_PAGES].sort(), [
    "agent-surface.html",
    "offscreen.html",
    "popup.html",
    "src/options.html",
  ]);
});

test("offscreen page discovery follows loader replacements and fails closed", () => {
  assert.deepEqual(
    runtimeHtmlPageEntryPoints(`
      const OFFSCREEN_PAGE = "offscreen-v2.html";
      chrome.offscreen.createDocument({ url: OFFSCREEN_PAGE, reasons: [] });
    `),
    ["offscreen-v2.html"],
  );
  assert.throws(
    () => runtimeHtmlPageEntryPoints("chrome.offscreen.createDocument({ url: choosePage() });"),
    /unsupported non-literal chrome\.offscreen\.createDocument url/,
  );
  assert.throws(
    () => runtimeHtmlPageEntryPoints(`
      const OFFSCREEN_PAGE = "stale.html";
      function open(OFFSCREEN_PAGE) {
        chrome.offscreen.createDocument({ url: OFFSCREEN_PAGE });
      }
    `),
    /unsupported non-literal chrome\.offscreen\.createDocument url/,
  );
  assert.throws(
    () => runtimeHtmlPageEntryPoints(`
      let offscreenPage = "stale.html";
      offscreenPage = "current.html";
      chrome.offscreen.createDocument({ url: offscreenPage });
    `),
    /unsupported non-literal chrome\.offscreen\.createDocument url/,
  );
});

test("production-injected scripts are package-graph entry points", () => {
  assert.deepEqual(INJECTED_SCRIPT_ENTRY_POINTS.sort(), [
    "src/a11y/live_region_observer.js",
    "src/content.js",
  ]);
});

test("injected-script discovery follows loader replacements and fails closed", () => {
  assert.deepEqual(
    injectedScriptEntryPoints('chrome.scripting.executeScript({ files: ["src/content-v2.js"] });'),
    ["src/content-v2.js"],
  );
  assert.throws(
    () => injectedScriptEntryPoints("chrome.scripting.executeScript({ files: runtimeFiles });"),
    /unsupported non-literal chrome\.scripting\.executeScript files/,
  );
});

test("every supported import form becomes a missing package member when omitted", () => {
  const cases = [
    ['import value from "./static-from.mjs";', "src/static-from.mjs"],
    ['import "./side-effect.mjs";', "src/side-effect.mjs"],
    ['import("./literal-dynamic.mjs");', "src/literal-dynamic.mjs"],
    ['import(chrome.runtime.getURL("src/extension-dynamic.mjs"));', "src/extension-dynamic.mjs"],
  ];
  for (const [source, expected] of cases) {
    const missing = resolvedImportedModules("src/fixture.mjs", source)
      .filter((module) => !new Set(["src/fixture.mjs"]).has(module));
    assert.deepEqual(missing, [expected], source);
  }
});

test("non-literal dynamic imports fail closed", () => {
  assert.throws(
    () => importedModuleSpecifiers("import(runtimeSelectedModule);"),
    /unsupported non-literal dynamic import/,
  );
});

test("bare module imports fail closed", () => {
  assert.throws(
    () => resolvedImportedModules("src/fixture.mjs", 'import "unbundled-package";'),
    /unsupported bare module import/,
  );
});

test("every module reachable from an extension entry point is in the packaging file list", () => {
  const zipped = zippedFiles();
  assert.ok(zipped.size > 20, `parsed only ${zipped.size} files from package-extension.sh — the regex is wrong, not the script`);

  const { seen, missingOnDisk } = reachableModules(ENTRY_POINTS);
  assert.deepEqual(missingOnDisk, [], `these are imported but do not exist on disk:\n  ${missingOnDisk.join("\n  ")}`);

  const missing = [...seen].filter((f) => !zipped.has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    "these modules are imported by the extension but NOT zipped — the packaged worker's module " +
      "graph will fail to instantiate, silently, with no exception and no log:\n  " + missing.join("\n  "),
  );
});

// The entry points themselves must ship, and so must the non-module assets the manifest names.
test("the service worker, extension pages, and every entry point are in the packaging file list", () => {
  const zipped = zippedFiles();
  const contentScripts = (MANIFEST.content_scripts || []).flatMap((entry) => entry.js || []);
  const required = [
    MANIFEST.background?.service_worker,
    ...MODULE_PAGES,
    ...ENTRY_POINTS,
    ...contentScripts,
  ].filter(Boolean);
  const missing = required.filter((f) => !zipped.has(f));
  assert.deepEqual(missing, [], `not zipped: ${missing.join(", ")}`);
});

test("the packaged extension builds and ships every generated browser bundle", () => {
  const script = readFileSync(path.join(REPO, "scripts/package-extension.sh"), "utf8");
  const zipped = zippedFiles();
  assert.match(
    script,
    /esbuild\.a11y\.mjs/,
    "package-extension.sh must build the ChromeVox a11y bundle from pinned sources",
  );
  assert.match(
    script,
    /esbuild\.protoface\.mjs/,
    "package-extension.sh must build the Protoface bundle from the pinned browser dependency",
  );
  assert.match(
    script,
    /esbuild\.protoface-broker\.mjs/,
    "package-extension.sh must build the background-owned Protoface broker bundle",
  );
  assert.ok(
    zipped.has("dist/a11y-bundle.js"),
    "package-extension.sh must ship dist/a11y-bundle.js",
  );
  assert.ok(
    zipped.has("dist/protoface-client-bundle.mjs"),
    "package-extension.sh must ship dist/protoface-client-bundle.mjs",
  );
  assert.ok(
    zipped.has("dist/protoface-broker-bundle.mjs"),
    "package-extension.sh must ship dist/protoface-broker-bundle.mjs",
  );
});

// `node --check` validates SCRIPT syntax. Every extension entry point is loaded as an ES MODULE
// (manifest `"type": "module"`, `<script type="module">`), and module-only early errors — `await`
// in a non-async function, a duplicate top-level binding, a bad export — are invisible to it.
//
// A module that fails to LINK does not throw. Chrome registers the service worker, evaluates ZERO
// statements of its body, registers no listeners, and reports nothing: no `Runtime.exceptionThrown`,
// no entry on chrome://extensions. The extension is inert and silent.
//
// Found 2026-07-09 after eleven refuted hypotheses: 8cb0a831 put `await` inside
// `attachRuntimeToOpenBridge`, a non-async arrow. `node --check` passed. Every unit test passed
// (they import background.js's leaf modules, never background.js). The extension had been broken on
// main for eight commits, and #188's live gate had been red the whole time.
test("every extension entry point parses as an ES module, not just as a script", async () => {
  const broken = [];
  for (const entry of ENTRY_POINTS) {
    const source = readFileSync(path.join(EXT, entry), "utf8");
    try {
      parse(source, { ecmaVersion: 2022, sourceType: "module" });
    } catch (error) {
      broken.push(`${entry}: ${error.message}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    "these fail to parse as ES modules — Chrome will register the worker and never evaluate it, " +
      "silently, with no exception and no log:\n  " + broken.join("\n  "),
  );
});
