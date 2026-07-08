import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Guards the 2026-07-05 finding: pasting a TSV block into Google Sheets
// collapsed into column A because syntheticClipboardEvent always derived the
// text/html clipboard flavor as <p>/<br> (never a <table>). The fix lets a
// clipboard.paste caller supply an exact `html` flavor. The html-flavor
// DECISION is factored into a pure helper `clipboardHtmlFlavor(text, html)` so
// it is source-sliceable and testable without a DOM DataTransfer:
//   - html a string  => used verbatim (caller controls it: e.g. a <table>)
//   - html omitted    => derived from text via clipboardHtmlFromText (back-compat)

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

// Slice both the derivation helper and the flavor-decision helper so the
// decision helper can call the derivation helper in the test sandbox.
const loadFlavorHelper = () => {
  const derStart = contentSource.indexOf("const clipboardHtmlFromText");
  assert.ok(derStart >= 0, "clipboardHtmlFromText must exist in content.js");
  const derEnd = contentSource.indexOf("};", derStart);
  const derSource = contentSource.slice(derStart, derEnd + 2);

  const flavStart = contentSource.indexOf("const clipboardHtmlFlavor");
  assert.ok(
    flavStart >= 0,
    "clipboardHtmlFlavor must exist in content.js (the pure html-flavor decision)",
  );
  const flavEnd = contentSource.indexOf("};", flavStart);
  const flavSource = contentSource.slice(flavStart, flavEnd + 2);

  // eslint-disable-next-line no-new-func
  return new Function(
    `${derSource}\n${flavSource}\n return clipboardHtmlFlavor;`,
  )();
};

test("explicit html arg is used verbatim as the text/html flavor", () => {
  const clipboardHtmlFlavor = loadFlavorHelper();
  const table = "<table><tr><td>Name</td><td>Stage</td></tr></table>";
  assert.equal(clipboardHtmlFlavor("Name\tStage", table), table);
});

test("omitted html falls back to clipboardHtmlFromText derivation", () => {
  const clipboardHtmlFlavor = loadFlavorHelper();
  assert.equal(clipboardHtmlFlavor("one line", undefined), "<p>one line</p>");
  assert.equal(
    clipboardHtmlFlavor("Profile\n\nStatus", null),
    "<p>Profile</p><p>Status</p>",
  );
});

test("empty-string html is treated as absent (derive), not an empty flavor", () => {
  // An empty html string is not a meaningful flavor; fall back to derivation so
  // a caller passing "" does not silently strip the html flavor.
  const clipboardHtmlFlavor = loadFlavorHelper();
  assert.equal(clipboardHtmlFlavor("hello", ""), "<p>hello</p>");
});

test("syntheticClipboardEvent routes text/html through clipboardHtmlFlavor", () => {
  const fnStart = contentSource.indexOf("const syntheticClipboardEvent");
  assert.ok(fnStart >= 0, "syntheticClipboardEvent must exist");
  const fnBody = contentSource.slice(fnStart, fnStart + 700);
  assert.ok(
    /setData\("text\/html", clipboardHtmlFlavor\(/.test(fnBody),
    "text/html flavor must be produced by clipboardHtmlFlavor(text, html)",
  );
});

test("clipboardPaste threads args.html into the synthetic event", () => {
  const fnStart = contentSource.indexOf("const clipboardPaste");
  assert.ok(fnStart >= 0, "clipboardPaste must exist");
  const fnBody = contentSource.slice(fnStart, fnStart + 1400);
  assert.ok(
    /syntheticClipboardEvent\(payload, args\.html\)/.test(fnBody),
    "clipboardPaste must pass args.html to syntheticClipboardEvent",
  );
});

test("clipboard.paste advertises optional html in both manifest surfaces", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../actions/overlay.actions.json", import.meta.url),
      "utf8",
    ),
  );
  const tool = manifest.tools.find((t) => t.name === "clipboard.paste");
  assert.ok(tool, "tools[] missing clipboard.paste");
  assert.equal(
    tool.input_schema.properties.html.type,
    "string",
    "tools[] clipboard.paste must declare an html string property",
  );
  const prim = manifest.primitive_dictionary.primitives.find(
    (p) => p.name === "clipboard.paste",
  );
  assert.ok(prim, "primitive_dictionary missing clipboard.paste");
  assert.equal(
    prim.input_schema.properties.html.type,
    "string",
    "primitive_dictionary clipboard.paste must declare an html string property",
  );
});
