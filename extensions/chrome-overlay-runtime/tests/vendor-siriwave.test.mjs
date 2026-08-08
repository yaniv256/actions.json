import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import SiriWave from "../src/agent/vendor/siriwave.mjs";

const vendorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/agent/vendor/siriwave.mjs",
);

// siriwave's constructor needs a DOM: it calls document.createElement("canvas"),
// canvas.getContext("2d"), and container.appendChild(canvas). node:test has no
// DOM, so we install the smallest stub that satisfies those three calls. The
// stub records what the library asks for, so the construction assertions below
// are checking real library behaviour rather than passing trivially.
//
// NOT COVERED by this stub — and deliberately not asserted anywhere in this
// file: actual pixel rendering, curve geometry, the requestAnimationFrame draw
// loop, and visual correctness of the waveform. Those need a real browser
// canvas and belong in a Playwright/extension-level test, not here.
function createCanvasStub() {
  const context2d = {
    calls: [],
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    shadowBlur: 0,
    shadowColor: "",
    // This member list is not guessed: it is every `ctx.*` reference in the
    // vendored siriwave.mjs. If a future re-vendor uses a new context call, the
    // draw assertions below fail loudly rather than silently skipping it.
    clearRect: (...args) => context2d.calls.push(["clearRect", ...args]),
    fillRect: (...args) => context2d.calls.push(["fillRect", ...args]),
    beginPath: () => context2d.calls.push(["beginPath"]),
    moveTo: (...args) => context2d.calls.push(["moveTo", ...args]),
    lineTo: (...args) => context2d.calls.push(["lineTo", ...args]),
    stroke: () => context2d.calls.push(["stroke"]),
    fill: () => context2d.calls.push(["fill"]),
    closePath: () => context2d.calls.push(["closePath"]),
    createLinearGradient: (...args) => {
      context2d.calls.push(["createLinearGradient", ...args]);
      return { addColorStop: () => {} };
    },
  };

  const canvas = {
    tagName: "CANVAS",
    style: {},
    width: 0,
    height: 0,
    removed: false,
    getContext: (kind) => {
      canvas.requestedContext = kind;
      return context2d;
    },
    remove: () => {
      canvas.removed = true;
    },
  };

  return { canvas, context2d };
}

// A detached container: it is NOT in any document, which is exactly the case
// the pill hits when it is constructed before it becomes visible.
function createDetachedContainer(canvas) {
  const container = {
    appended: [],
    offsetWidth: 320,
    offsetHeight: 100,
    appendChild: (child) => {
      container.appended.push(child);
      return child;
    },
  };

  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, "canvas", "siriwave should only create a canvas element");
      return canvas;
    },
  };
  // siriwave reads the container's computed width/height (as px strings) to size
  // the canvas. A detached element reports zeros in a real browser; we return
  // concrete sizes so the geometry path is exercised rather than short-circuited.
  //
  // No requestAnimationFrame: siriwave guards on `window.requestAnimationFrame`,
  // so omitting it keeps the draw loop from scheduling frames the test cannot join.
  globalThis.window = {
    devicePixelRatio: 1,
    getComputedStyle: (element) => {
      assert.equal(element, container, "siriwave should measure the container it was given");
      return { width: "320px", height: "100px" };
    },
  };

  return container;
}

function withStubbedDom(run) {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const { canvas, context2d } = createCanvasStub();
  const container = createDetachedContainer(canvas);
  try {
    return run({ container, canvas, context2d });
  } finally {
    globalThis.document = priorDocument;
    globalThis.window = priorWindow;
  }
}

test("module exposes a constructor as its default export", () => {
  assert.equal(typeof SiriWave, "function");
  // A class constructor cannot be called without `new`; this distinguishes a
  // real constructor from a plain function that would also be `typeof function`.
  assert.throws(() => SiriWave({ container: {} }), TypeError);
});

test("the vendored public API matches the methods the pill depends on", () => {
  const api = SiriWave.prototype;
  for (const method of ["setAmplitude", "setSpeed", "start", "stop", "dispose", "set"]) {
    assert.equal(typeof api[method], "function", `SiriWave.prototype.${method} should be a function`);
  }
});

test("constructs against a detached container and drives amplitude without throwing", () => {
  withStubbedDom(({ container, canvas, context2d }) => {
    const wave = new SiriWave({ container, style: "ios9", autostart: false });

    // Construction really did go through the canvas path, so the calls below are
    // exercising a constructed instance rather than an inert object.
    assert.equal(canvas.requestedContext, "2d");
    assert.deepEqual(container.appended, [canvas]);
    assert.equal(wave.canvas, canvas);
    assert.equal(wave.ctx, context2d);

    // The pill may push amplitude before the canvas is visible.
    assert.doesNotThrow(() => wave.setAmplitude(0));
    assert.equal(wave.interpolation.amplitude, 0);

    assert.doesNotThrow(() => wave.setAmplitude(1));
    assert.equal(wave.interpolation.amplitude, 1);

    assert.doesNotThrow(() => wave.setSpeed(0.5));
    assert.equal(wave.interpolation.speed, 0.5);
  });
});

test("start/stop/dispose are safe on a detached canvas", () => {
  withStubbedDom(({ container, canvas, context2d }) => {
    const wave = new SiriWave({ container, autostart: false });

    assert.equal(wave.run, false);
    assert.equal(context2d.calls.length, 0, "nothing should be drawn before start()");

    assert.doesNotThrow(() => wave.start());
    assert.equal(wave.run, true, "start() should mark the instance as running");
    // start() runs one synchronous draw cycle. Asserting it reached the canvas
    // proves the vendored code actually renders, not merely that it constructs.
    assert.ok(
      context2d.calls.length > 0,
      "start() should issue at least one 2d context call",
    );

    assert.doesNotThrow(() => wave.stop());
    assert.equal(wave.run, false, "stop() should clear the running flag");

    assert.doesNotThrow(() => wave.dispose());
    assert.equal(canvas.removed, true, "dispose() should detach the canvas it created");
    assert.equal(wave.canvas, null);
  });
});

test("provenance header names the package, version and license", () => {
  const header = readFileSync(vendorPath, "utf8").split("\n").slice(0, 4).join("\n");

  assert.match(header, /siriwave@\d+\.\d+\.\d+/, "header should pin an exact vendored version");
  assert.match(header, /\bMIT\b/, "header should name a recognizable license identifier");
  assert.match(header, /https:\/\/www\.npmjs\.com\/package\/siriwave/, "header should cite the source package");
});
