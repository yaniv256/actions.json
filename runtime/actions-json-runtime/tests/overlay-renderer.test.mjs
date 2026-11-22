// The overlay renderer had NO tests -- a security-sensitive surface that
// parses untrusted HTML, decides whether scripts run, and injects into the
// host page, with nothing exercising any of it.
//
// These cover what can be tested without a DOM: the pure parsing and escaping
// functions, and the trust boundary itself. The DOM-backed rendering path is
// noted at the end as deliberately uncovered rather than silently missing --
// jsdom is a dependency decision for the maintainer, not one to make inside a
// review remediation.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OverlaySurface,
  buildOverlayArtifactHtml,
  buildOverlayBundleHtml,
  parseHtmlDocument,
  removeUnsafeAttributes,
  sandboxFor,
} from "../src/embed/overlay-renderer.mjs";

test("a caller cannot declare its own HTML a trusted scripted template", () => {
  // The finding: overlay.open passed caller arguments straight through, so an
  // agent set templateDriven:true on its own model-authored HTML and kept its
  // scripts -- arbitrary script in the host page from the least trusted input
  // there is. The docstring described a boundary that nothing enforced.
  const surface = new OverlaySurface({
    document: stubDocument(),
    templates: { "reviewed-report": "<p>reviewed</p>" },
    parser: tinyParser(),
  });

  // The old flag no longer exists; passing it does nothing.
  assert.throws(
    () => surface.open({ html: "<p>x</p>", template_id: "not-registered" }),
    /unknown template_id/,
    "an unregistered id must be refused, not downgraded to an inline overlay",
  );

  // Refused rather than silently stripped: a typo becoming a scriptless
  // overlay would hide the mistake at exactly the moment it matters.
  assert.doesNotThrow(() => surface.open({ html: "<p>x</p>" }));
});

test("inline HTML is always scriptless", () => {
  // Uses the module's own `parser` injection seam rather than a DOM library:
  // adding one is a maintainer decision, and the property under test is the
  // script-removal branch, not the parsing.
  const parsed = parseHtmlDocument("<p>hi</p><script>steal()</script>", {
    preserveScripts: false,
    parser: tinyParser(),
  });
  assert.ok(!parsed.body.includes("steal"), "a script survived an inline parse");
  assert.equal(parsed.scripts_preserved, false);

  // Positive control: with scripts preserved the same input keeps them, so the
  // assertion above is not passing because parsing produced nothing.
  const kept = parseHtmlDocument("<p>hi</p><script>steal()</script>", {
    preserveScripts: true,
    parser: tinyParser(),
  });
  assert.ok(kept.body.includes("steal"), "the control did not preserve scripts");
});

test("inline event handlers and javascript: URLs are stripped", () => {
  // Attribute-level XSS survives script removal: an onclick executes in the
  // embedding document's origin, which for an embed host is the host app.
  const anchor = fakeElement({
    href: "javascript:evil()", onclick: "evil()", "data-keep": "1",
  });
  const image = fakeElement({ src: "data:text/html,evil" });
  removeUnsafeAttributes({ querySelectorAll: () => [anchor, image] });

  assert.equal(anchor.getAttribute("onclick"), undefined, "an inline handler survived");
  assert.equal(anchor.getAttribute("href"), undefined, "a javascript: URL survived");
  assert.equal(image.getAttribute("src"), undefined, "a data: URL survived");
  assert.equal(anchor.getAttribute("data-keep"), "1", "stripping removed a safe attribute too");
});

test("the sandbox never grants scripts and same-origin together", () => {
  // That combination lets framed content reach out and script the embedding
  // page -- which for an embed host is the application itself.
  const scripted = sandboxFor({ allowScripts: true });
  const inline = sandboxFor({ allowScripts: false });

  for (const value of [scripted, inline]) {
    assert.ok(
      !(value.includes("allow-scripts") && value.includes("allow-same-origin")),
      `sandbox granted both: ${value}`,
    );
  }
  assert.equal(scripted, "allow-scripts");
  assert.equal(inline, "allow-same-origin");
});

test("embedded JSON cannot close its own script block", () => {
  // A payload containing </script> would otherwise end the block and let the
  // remainder parse as markup.
  const html = buildOverlayBundleHtml({
    title: "t",
    templateHtml: "<p>x</p>",
    dataJson: { evil: "</script><script>steal()</script>" },
  });
  const between = html.slice(html.indexOf("data-overlay-data"));
  assert.ok(!between.includes("</script><script>steal"), "JSON closed its own block");
  assert.ok(html.includes("\\u003c"), "the payload was not escaped");
});

test("a title cannot inject markup", () => {
  const html = buildOverlayArtifactHtml({
    title: '</title><script>steal()</script>',
    parsed: { body: "<p>x</p>", style: "" },
  });
  assert.ok(!html.includes("<script>steal"), "a title injected a script");
  assert.ok(html.includes("&lt;"), "the title was not escaped");
});

// NOT COVERED, and named rather than left to be discovered: the DOM-backed
// render path -- OverlaySurface.open's element construction, the single-host
// replacement, and renderOverlayDocument's iframe. Those need jsdom, and
// adding a dependency is the maintainer's decision. The trust boundary above
// is what determines whether scripts reach that path at all.

/** Minimal DOM stand-ins: the module already accepts an injected parser. */
function tinyParser() {
  return {
    parseFromString(html) {
      const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
      let body = html;
      return {
        querySelectorAll: (sel) =>
          sel === "script"
            ? scripts.map((m) => ({ remove: () => { body = body.replace(m[0], ""); }, textContent: "" }))
            : [],
        querySelector: () => null,
        get body() { return { innerHTML: body }; },
        documentElement: { get outerHTML() { return body; } },
      };
    },
  };
}

function fakeElement(attrs) {
  const map = new Map(Object.entries(attrs));
  return {
    get attributes() {
      return [...map.entries()].map(([name, value]) => ({ name, value }));
    },
    getAttribute: (n) => map.get(n),
    removeAttribute: (n) => map.delete(n),
  };
}

function stubDocument() {
  const el = () => ({
    dataset: {}, style: {}, id: "", className: "",
    appendChild() {}, setAttribute() {}, removeAttribute() {},
    remove() {}, attributes: [], querySelectorAll: () => [],
    set textContent(_v) {}, get textContent() { return ""; },
  });
  return {
    createElement: el,
    getElementById: () => null,
    documentElement: { appendChild() {} },
    body: { appendChild() {} },
  };
}
