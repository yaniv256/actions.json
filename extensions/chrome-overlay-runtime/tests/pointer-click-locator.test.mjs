import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A workflow can wait behind per-tab pacing after it resolves target geometry.
// Coordinates captured before that wait may no longer identify the same control.
// pointer.click therefore accepts a locator and resolves its center inside the
// primitive, immediately before dispatching the pointer event sequence.

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const bookmarkletSource = await readFile(
  new URL(
    "../../../runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.js",
    import.meta.url,
  ),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

for (const [runtime, source] of [
  ["content.js", contentSource],
  ["bookmarklet", bookmarkletSource],
]) {
  test(`${runtime}: pointerClick resolves a point from coordinates or a locator`, () => {
    const start = Math.max(
      source.indexOf("const pointerClick = (args = {}) =>"),
      source.indexOf("function pointerClick(args = {})"),
    );
    const next = Math.min(
      ...[
        source.indexOf("const pointerMove", start + 1),
        source.indexOf("function pointerMove", start + 1),
      ].filter((index) => index >= 0),
    );
    assert.ok(start >= 0 && next > start, "pointerClick implementation must be discoverable");
    const pointerClickBody = source.slice(start, next);
    assert.match(
      pointerClickBody,
      /pointFromViewportPointOrLocator\("pointer\.click", args, "target"\)/,
      "pointerClick must resolve locator geometry at dispatch time",
    );
    assert.doesNotMatch(
      pointerClickBody,
      /requirePointCoordinates\("pointer\.click", args\)/,
      "a locator-only click must not be rejected as missing coordinates",
    );
    assert.match(
      pointerClickBody,
      /geometry/,
      "pointerClick output must say whether coordinates or locator identity was used",
    );
  });

  test(`${runtime}: locators can select a deterministic zero-based match`, () => {
    const start = source.indexOf("resolveLocatorCandidates");
    assert.ok(start >= 0, "locator resolver must be discoverable");
    const resolverBody = source.slice(start, start + 5000);
    assert.match(
      resolverBody,
      /match_index/,
      "locator resolution must support a deterministic match_index",
    );
    assert.match(
      resolverBody,
      /Number\.isInteger/,
      "match_index must reject fractional and non-numeric indexes",
    );
    assert.match(
      resolverBody,
      /retarget\.text_equals/,
      "retargeting must be able to preserve the target control's text identity",
    );
  });
}

test("pointer.click tool and primitive schemas accept a locator alternative", () => {
  for (const surface of [
    manifest.tools.find((tool) => tool.name === "pointer.click"),
    manifest.primitive_dictionary.primitives.find(
      (primitive) => primitive.name === "pointer.click",
    ),
  ]) {
    assert.ok(surface, "pointer.click must exist on both manifest surfaces");
    assert.equal(surface.input_schema?.properties?.locator?.type, "object");
    assert.ok(
      Array.isArray(surface.input_schema?.anyOf),
      "pointer.click schema must require coordinates or a locator",
    );
  }
});
