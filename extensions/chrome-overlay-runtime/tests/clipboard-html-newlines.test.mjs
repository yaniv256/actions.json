import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-04 wall-of-text finding.
//
// text.insert delivers contenteditable insertions as a synthetic paste event
// carrying both text/plain and text/html flavors. Rich-text editors such as
// ProseMirror (Trello card descriptions and comments) prefer the text/html
// flavor — and in HTML, raw newlines are collapsible whitespace. The original
// implementation set text/html to the escaped plain text verbatim, so every
// multi-line description flattened into a single unreadable line while the
// newline-preserving text/plain flavor sat shadowed underneath.
//
// The fix encodes paragraph structure explicitly in the html flavor:
// blank-line-separated blocks become <p> elements and single newlines become
// <br>, so pasted text renders with the same paragraph breaks the caller wrote.

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

const extractClipboardHtmlFromText = () => {
  const start = contentSource.indexOf("const clipboardHtmlFromText");
  assert.ok(start >= 0, "clipboardHtmlFromText must exist in content.js");
  const end = contentSource.indexOf("};", start);
  const source = contentSource.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${source} return clipboardHtmlFromText;`)();
};

test("synthetic paste html flavor is routed through clipboardHtmlFlavor", () => {
  const fnStart = contentSource.indexOf("const syntheticClipboardEvent");
  assert.ok(fnStart >= 0, "syntheticClipboardEvent must exist");
  const fnBody = contentSource.slice(fnStart, fnStart + 700);
  assert.ok(
    fnBody.includes('setData("text/html", clipboardHtmlFlavor(text, html))'),
    "text/html flavor must be produced by clipboardHtmlFlavor (which derives via clipboardHtmlFromText when no explicit html is given), not raw escaped text",
  );
});

test("blank-line-separated blocks become <p> paragraphs", () => {
  const clipboardHtmlFromText = extractClipboardHtmlFromText();
  assert.equal(
    clipboardHtmlFromText("Profile\n\nStatus\n\nNext"),
    "<p>Profile</p><p>Status</p><p>Next</p>",
  );
});

test("single newlines become <br> within a paragraph", () => {
  const clipboardHtmlFromText = extractClipboardHtmlFromText();
  assert.equal(
    clipboardHtmlFromText("Profile\n- line one\n- line two"),
    "<p>Profile<br>- line one<br>- line two</p>",
  );
});

test("html-sensitive characters stay escaped", () => {
  const clipboardHtmlFromText = extractClipboardHtmlFromText();
  assert.equal(
    clipboardHtmlFromText("a < b & \"c\"\n\nnext"),
    "<p>a &lt; b &amp; &quot;c&quot;</p><p>next</p>",
  );
});

test("single-line text still renders as one paragraph", () => {
  const clipboardHtmlFromText = extractClipboardHtmlFromText();
  assert.equal(clipboardHtmlFromText("one line"), "<p>one line</p>");
});
