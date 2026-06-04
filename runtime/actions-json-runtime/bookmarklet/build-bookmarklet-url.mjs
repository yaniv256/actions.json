import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "storage-bookmarklet.js");
const outputPath = join(here, "storage-bookmarklet.url");
const installerPath = join(here, "install.html");

const source = readFileSync(sourcePath, "utf8");
const minified = await minify(source, {
  compress: {
    defaults: true,
    passes: 2,
    toplevel: true,
  },
  mangle: {
    toplevel: true,
  },
  format: {
    comments: false,
  },
});
if (!minified.code) {
  throw new Error("Failed to minify bookmarklet source");
}
const bookmarklet = `javascript:${encodeURIComponent(minified.code)}`;

writeFileSync(outputPath, `${bookmarklet}\n`);
writeFileSync(installerPath, buildInstallerHtml(bookmarklet));
console.log(`Wrote ${outputPath}`);
console.log(`Wrote ${installerPath}`);
console.log(`${bookmarklet.length} characters`);

function buildInstallerHtml(bookmarkletUrl) {
  const icon = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111827"/>
  <path d="M19 20h26M19 32h26M19 44h26" stroke="#f9fafb" stroke-width="5" stroke-linecap="round"/>
  <circle cx="16" cy="20" r="3" fill="#38bdf8"/>
  <circle cx="16" cy="32" r="3" fill="#a3e635"/>
  <circle cx="16" cy="44" r="3" fill="#f97316"/>
</svg>
`)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install actions.json Bookmarklet</title>
  <link rel="icon" href="${icon}">
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: Canvas;
      color: CanvasText;
    }
    main {
      width: min(680px, calc(100vw - 48px));
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      font-size: 15px;
      line-height: 1.55;
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    .bookmarklet {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      background: color-mix(in srgb, Canvas 88%, CanvasText 12%);
      color: CanvasText;
      text-decoration: none;
      font-size: 15px;
      font-weight: 650;
    }
    .steps {
      display: grid;
      gap: 8px;
      padding-left: 20px;
      margin: 0;
      color: color-mix(in srgb, CanvasText 78%, transparent);
      font-size: 14px;
      line-height: 1.5;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.95em;
    }
  </style>
</head>
<body>
  <main>
    <h1>Install actions.json</h1>
    <p>Drag this link to your Chrome bookmarks bar. Then open a website and click the bookmark to load, write, and sync page-relevant <code>actions.json</code> files.</p>
    <a class="bookmarklet" href="${escapeHtml(bookmarkletUrl)}">actions.json</a>
    <ol class="steps">
      <li>Show the bookmarks bar if it is hidden.</li>
      <li>Drag the <strong>actions.json</strong> link above into the bookmarks bar.</li>
      <li>Open a target page and click the bookmark.</li>
    </ol>
  </main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
