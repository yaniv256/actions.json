import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(
    new URL("../actions/overlay.actions.json", import.meta.url),
    "utf8",
  ),
);

const FAMILY = [
  "text.select",
  "clipboard.copy",
  "clipboard.paste",
  "clipboard.read",
  "clipboard.write",
];

test("all five primitives are advertised in tools[]", () => {
  const names = new Set(manifest.tools.map((t) => t.name));
  for (const n of FAMILY) assert.ok(names.has(n), `tools[] missing ${n}`);
});

test("all five primitives are in primitive_dictionary with required fields", () => {
  const prims = manifest.primitive_dictionary.primitives;
  const byName = new Map(prims.map((p) => [p.name, p]));
  for (const n of FAMILY) {
    const p = byName.get(n);
    assert.ok(p, `primitive_dictionary missing ${n}`);
    assert.equal(p.support, "supported", `${n} must be supported`);
    assert.ok(
      typeof p.summary === "string" && p.summary.length,
      `${n} needs summary`,
    );
    assert.equal(typeof p.input_schema, "object", `${n} needs input_schema`);
  }
});

test("clipboard.read and clipboard.write appear exactly once per surface", () => {
  for (const n of ["clipboard.read", "clipboard.write"]) {
    assert.equal(
      manifest.tools.filter((t) => t.name === n).length,
      1,
      `duplicate or missing ${n} in tools[]`,
    );
    assert.equal(
      manifest.primitive_dictionary.primitives.filter((p) => p.name === n).length,
      1,
      `duplicate or missing ${n} in primitive_dictionary`,
    );
  }
});

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

const sliceConst = (name) => {
  const start = contentSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist in content.js`);
  const marker = "\n  };";
  const end = contentSource.indexOf(marker, start);
  assert.ok(end > start, `${name} body end not found`);
  // include the full "\n  };" terminator so the sliced const is a complete
  // statement (missing the trailing ';' makes `... } return name;` a syntax error)
  return contentSource.slice(start, end + marker.length);
};

// pasteTargetKind is now the simple resolved/activeElement chooser — frame
// targeting (reaching inside an iframe) lives in the frame-aware locator, not
// here. See tests/frame-aware-locator.test.mjs.
test("pasteTargetKind uses the resolved element", () => {
  const src = sliceConst("pasteTargetKind");
  const pasteTargetKind = new Function(`${src} return pasteTargetKind;`)();
  const input = { tagName: "INPUT" };
  const active = { tagName: "DIV" };
  assert.deepEqual(pasteTargetKind(input, active), {
    target: input,
    target_kind: "resolved-locator",
  });
});

test("pasteTargetKind falls back to activeElement when unresolved", () => {
  const src = sliceConst("pasteTargetKind");
  const pasteTargetKind = new Function(`${src} return pasteTargetKind;`)();
  const active = { tagName: "DIV" };
  assert.deepEqual(pasteTargetKind(null, active), {
    target: active,
    target_kind: "activeElement",
  });
});
