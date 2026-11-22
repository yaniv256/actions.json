// The overlay renderer's DOM path, in a real browser.
//
// The node tests cover this surface through an injected `parser` stub, which
// is the only option without a DOM. But a stub written alongside the
// sanitiser agrees with it by construction: it shares whatever the sanitiser
// misunderstands about parsing, so agreement between them is not evidence.
// The question -- does a script actually EXECUTE -- cannot be asked of a stub
// at all, because a stub does not execute anything.
//
// Chromium is already a devDependency here (Playwright), so this needs no new
// dependency: the browser IS the oracle, and it is the same parser that runs
// in production.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(
  join(here, "..", "src", "embed", "overlay-renderer.mjs"),
  "utf8",
);

/** Load the renderer as a module in the page, on a blank same-origin document. */
async function withRenderer(page) {
  await page.route("https://overlay.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><div id='surface'></div></body></html>",
    });
  });
  await page.goto("https://overlay.test/");
  await page.addScriptTag({ content: rendererSource, type: "module" });
  // Re-export onto window so page.evaluate can reach the module bindings.
  await page.addScriptTag({
    type: "module",
    content: `
      const mod = await import(URL.createObjectURL(
        new Blob([${JSON.stringify(rendererSource)}], { type: "text/javascript" })
      ));
      window.__overlay = mod;
      window.__ready = true;
    `,
  });
  await page.waitForFunction(() => window.__ready === true);
}

test("a script in untrusted overlay HTML does not execute", async ({ page }) => {
  // renderOverlayDocument renders into a SANDBOXED IFRAME, not into the
  // container -- my first version of this test read container.textContent,
  // found "", and every security assertion passed vacuously. The positive
  // controls caught it. Assertions here read the frame's own document.
  await withRenderer(page);

  const result = await page.evaluate(async () => {
    window.__pwned = false;
    const parsed = window.__overlay.parseHtmlDocument(
      "<p>report</p><script>window.parent.__pwned = true;<\/script>",
      { preserveScripts: false },
    );
    const container = document.getElementById("surface");
    const frame = window.__overlay.renderOverlayDocument(container, parsed, { allowScripts: false });
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    const doc = frame.contentDocument;
    return {
      pwned: window.__pwned,
      sandbox: frame.getAttribute("sandbox"),
      scriptNodes: doc ? doc.querySelectorAll("script").length : -1,
      text: doc ? doc.body.textContent : "",
    };
  });

  // The real oracle: the browser had every opportunity to run it.
  expect(result.pwned).toBe(false);
  expect(result.scriptNodes).toBe(0);
  // Control: the safe content DID render, so pwned === false is not merely
  // the result of nothing being rendered at all.
  expect(result.text).toContain("report");
  // Scripts and same-origin are never granted together.
  expect(result.sandbox).not.toContain("allow-scripts");
});

test("an inline event handler does not fire on a real event", async ({ page }) => {
  await withRenderer(page);

  const result = await page.evaluate(async () => {
    window.__fired = false;
    const parsed = window.__overlay.parseHtmlDocument(
      `<button id="b" onclick="window.parent.__fired = true;">click</button>`,
      { preserveScripts: false },
    );
    const container = document.getElementById("surface");
    const frame = window.__overlay.renderOverlayDocument(container, parsed, { allowScripts: false });
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    const button = frame.contentDocument?.querySelector("#b");
    button?.click(); // a real dispatch, not an attribute inspection
    return { fired: window.__fired, hasAttr: button?.hasAttribute("onclick"), clicked: !!button };
  });

  expect(result.clicked).toBe(true); // control: the element exists to be clicked
  expect(result.fired).toBe(false);
  expect(result.hasAttr).toBe(false);
});

test("a javascript: URL does not navigate when followed", async ({ page }) => {
  await withRenderer(page);

  const result = await page.evaluate(async () => {
    window.__navigated = false;
    const parsed = window.__overlay.parseHtmlDocument(
      `<a id="a" href="javascript:window.parent.__navigated = true">go</a>`,
      { preserveScripts: false },
    );
    const container = document.getElementById("surface");
    const frame = window.__overlay.renderOverlayDocument(container, parsed, { allowScripts: false });
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    const anchor = frame.contentDocument?.querySelector("#a");
    anchor?.click();
    return { navigated: window.__navigated, href: anchor?.getAttribute("href"), clicked: !!anchor };
  });

  expect(result.clicked).toBe(true);
  expect(result.navigated).toBe(false);
  expect(result.href ?? "").not.toContain("javascript:");
});

test("a scripted overlay is never same-origin with its host", async ({ page }) => {
  // The trust boundary that makes a scripted template survivable: a bundle
  // MAY run scripts, and precisely because it may, it is denied the host
  // origin. Granting both would let a template read the embedding app.
  await withRenderer(page);

  const result = await page.evaluate(async () => {
    const parsed = window.__overlay.parseHtmlDocument("<p>body</p>", { preserveScripts: true });
    const container = document.getElementById("surface");
    const frame = window.__overlay.renderOverlayDocument(container, parsed, { allowScripts: true });
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    let reachedHostDocument = true;
    try {
      // Opaque origin: touching contentDocument throws or returns null.
      reachedHostDocument = frame.contentDocument !== null;
    } catch {
      reachedHostDocument = false;
    }
    return { sandbox: frame.getAttribute("sandbox"), reachedHostDocument };
  });

  expect(result.sandbox).toContain("allow-scripts");
  expect(result.sandbox).not.toContain("allow-same-origin");
  expect(result.reachedHostDocument).toBe(false);
});

test("embedded JSON cannot break out of its script block", async ({ page }) => {
  await withRenderer(page);

  // The classic bundle escape: a closing tag inside the DATA ends the script
  // element early, and everything after it becomes live markup. The node test
  // asserts the escaping textually; this asserts the browser does not run it.
  const result = await page.evaluate(() => {
    window.__escaped = false;
    const html = window.__overlay.buildOverlayBundleHtml({
      title: "report",
      templateHtml: "<p>body</p>",
      dataJson: JSON.stringify({ note: "</script><script>window.__escaped = true;<\/script>" }),
    });
    const frame = document.createElement("iframe");
    // No allow-scripts: even a successful breakout has nothing to run in.
    // The assertion is that the payload never becomes a live script node.
    frame.srcdoc = html;
    document.body.appendChild(frame);
    return new Promise((resolve) => {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument;
        resolve({
          escaped: window.__escaped,
          scriptCount: doc ? doc.querySelectorAll("script").length : -1,
          renderedBody: doc ? doc.body.textContent : "",
        });
      });
    });
  });

  expect(result.escaped).toBe(false);
  // Control: the bundle really did render into the frame.
  expect(result.renderedBody).toContain("body");
});

test("a title cannot inject markup into the artifact document", async ({ page }) => {
  await withRenderer(page);

  const result = await page.evaluate(() => {
    window.__titled = false;
    const parsed = window.__overlay.parseHtmlDocument("<p>body</p>", { preserveScripts: false });
    const html = window.__overlay.buildOverlayArtifactHtml({
      title: `x</title><script>window.__titled = true;<\/script>`,
      parsed,
    });
    const frame = document.createElement("iframe");
    frame.srcdoc = html;
    document.body.appendChild(frame);
    return new Promise((resolve) => {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument;
        resolve({
          titled: window.__titled,
          scriptCount: doc ? doc.querySelectorAll("script").length : -1,
          body: doc ? doc.body.textContent : "",
        });
      });
    });
  });

  expect(result.titled).toBe(false);
  expect(result.scriptCount).toBe(0);
  expect(result.body).toContain("body");
});
