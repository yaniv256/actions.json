import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

const manifest = JSON.parse(
  await readFile(
    new URL("../actions/overlay.actions.json", import.meta.url),
    "utf8",
  ),
);

const sliceConst = (name) => {
  const start = contentSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist in content.js`);
  const marker = "\n  };";
  const end = contentSource.indexOf(marker, start);
  assert.ok(end > start, `${name} body end not found`);
  return contentSource.slice(start, end + marker.length);
};

test("page.fetch is advertised in both manifest surfaces", () => {
  assert.ok(
    manifest.tools.some((t) => t.name === "page.fetch"),
    "tools[] missing page.fetch",
  );
  const p = manifest.primitive_dictionary.primitives.find(
    (x) => x.name === "page.fetch",
  );
  assert.ok(p, "primitive_dictionary missing page.fetch");
  assert.equal(p.support, "supported");
  assert.ok(typeof p.summary === "string" && p.summary.length);
  assert.equal(typeof p.input_schema, "object");
});

test("isSameOrigin accepts same origin, rejects different origin/scheme/port/garbage", () => {
  const isSameOrigin = new Function(
    `${sliceConst("isSameOrigin")}\n return isSameOrigin;`,
  )();
  const origin = "https://docs.google.com";
  assert.equal(isSameOrigin("https://docs.google.com/document/d/x/mobilebasic", origin), true);
  assert.equal(isSameOrigin("https://docs.google.com/", origin), true);
  assert.equal(isSameOrigin("https://evil.com/x", origin), false);
  assert.equal(isSameOrigin("http://docs.google.com/x", origin), false); // scheme
  assert.equal(isSameOrigin("https://docs.google.com:8443/x", origin), false); // port
  assert.equal(isSameOrigin("not a url", origin), false);
  assert.equal(isSameOrigin("", origin), false);
});

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

test("page.fetch routes to the content script (not the background action set)", () => {
  assert.ok(
    !backgroundSource.includes('"page.fetch"'),
    "page.fetch must NOT be in the background action set (it is content-routed for same-origin cookies)",
  );
});
