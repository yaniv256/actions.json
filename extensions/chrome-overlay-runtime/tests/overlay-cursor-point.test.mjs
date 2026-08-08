// U8 — overlay.cursor.point, the ghost cursor primitive.
//
// These tests evaluate the REAL createGhostCursorController source extracted
// from the shipped src/content.js and run it in a vm against an injected fake
// DOM (the repo convention: no jsdom, dependencies are injected). Extracting
// the shipped text rather than re-implementing it is deliberate — a test that
// exercises a copy of the logic goes green while the shipped logic rots.
//
// The behaviours under test are the ones the borrowed technique
// (openai/realtime-voice-component's useGhostCursor, Apache-2.0) already solved,
// plus the correctness rule from
// A clickable center is only a coordinate until hit-testing proves its target:
// render at the HIT-TESTED point, never at a bounding-rect midpoint.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

// --- extract the shipped factory -------------------------------------------

function extractArrowFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `expected to find ${declaration} in content.js`);
  const brace = source.indexOf("{", source.indexOf("=>", start));
  assert.ok(brace >= 0, `expected ${declaration} to have a body`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && next === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (ch === "/" && next === "*") { i = source.indexOf("*/", i + 2) + 1; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`could not find the end of ${declaration}`);
}

const factorySource = extractArrowFunction(contentSource, "const createGhostCursorController = (deps) =>");

function loadFactory() {
  const context = vm.createContext({ Math, Date, Promise, Boolean, String, Number, Object });
  vm.runInContext(`${factorySource}\nglobalThis.__factory = createGhostCursorController;`, context);
  return context.__factory;
}

// Objects minted inside the vm carry that realm's Object.prototype, so
// assert.deepEqual fails its prototype check on structurally identical points.
// Compare the coordinates themselves.
const assertPoint = (actual, expected, message) => {
  assert.ok(actual, `${message}: expected a point, got ${actual}`);
  assert.equal(actual.x, expected.x, `${message}: x`);
  assert.equal(actual.y, expected.y, `${message}: y`);
};

// --- fake DOM ---------------------------------------------------------------

class FakeElement {
  constructor(tag, attrs = {}, rect = { left: 0, top: 0, right: 10, bottom: 10 }) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = attrs;
    this.id = attrs.id || "";
    this.rect = { ...rect };
    this.parentElement = null;
    this.children = [];
    this.scrollIntoViewCalls = [];
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { ...this.rect }; }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  scrollIntoView(options) {
    this.scrollIntoViewCalls.push(options);
    // Model a real scroll: centre the element in the viewport, and move the
    // window's scroll offset by the same amount the page would have moved.
    const width = this.rect.right - this.rect.left;
    const height = this.rect.bottom - this.rect.top;
    const top = (768 - height) / 2;
    const left = (1024 - width) / 2;
    if (this.ownerWindow) {
      this.ownerWindow.scrollY += this.rect.top - top;
      this.ownerWindow.scrollX += this.rect.left - left;
    }
    this.rect = { left, top, right: left + width, bottom: top + height };
  }
}

// `harness` builds a controller whose deps are all observable, so each test can
// assert on what the controller DID (render calls, scroll calls, listeners)
// rather than on the shape of its source text.
function harness(options = {}) {
  const {
    reducedMotion = false,
    hitTest = null,
    documentContains = () => true,
  } = options;

  const renders = [];
  const listeners = new Map();
  let clock = 0;
  const timers = [];

  const doc = {
    contains: documentContains,
    elementFromPoint: (x, y) => (hitTest ? hitTest(x, y) : null),
  };
  const win = {
    innerWidth: 1024,
    innerHeight: 768,
    // Scroll offsets are real state here: the controller distinguishes its own
    // scroll from the user's by WHERE the page ended up, so a harness that
    // never moved these would not exercise that mechanism at all.
    scrollX: 0,
    scrollY: 0,
    addEventListener: (type, handler, opts) => {
      listeners.set(type, { handler, opts });
    },
  };

  const controller = loadFactory()({
    doc,
    win,
    render: (payload) => renders.push(payload),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelScheduled: (timer) => { if (timer) timer.cancelled = true; },
    prefersReducedMotion: () => reducedMotion,
    overlayHostId: "__actions_json_menu_overlay_host",
    travelMs: 100,
    frameMs: 10,
  });

  // Drive the injected clock forward, firing scheduled animation frames.
  const advance = async (ms) => {
    const target = clock + ms;
    while (true) {
      const next = timers.find((t) => !t.cancelled && !t.fired && t.at <= target);
      if (!next) break;
      clock = next.at;
      next.fired = true;
      next.fn();
      await Promise.resolve();
    }
    clock = target;
    await Promise.resolve();
  };

  // Let a test queue its own event on the SAME fake clock the animation uses,
  // so a simulated browser event can land mid-flight rather than before the
  // animation has begun.
  const scheduleRaw = (fn, ms) => {
    const timer = { fn, at: clock + ms, cancelled: false };
    timers.push(timer);
    return timer;
  };

  // A USER scroll moves the page somewhere the controller did not put it, then
  // fires the event — the ordering a browser produces.
  const userScroll = (dy) => {
    win.scrollY += dy;
    listeners.get("scroll")?.handler({ type: "scroll" });
  };

  return {
    controller, renders, listeners, advance, scheduleRaw, userScroll, doc, win,
    tick: () => clock,
    // Elements must know which window they scroll, so scrollIntoView can move
    // that window's offsets the way a real scroll does.
    adopt: (element) => { element.ownerWindow = win; return element; },
  };
}

// --- the scenarios ----------------------------------------------------------

test("pointing at an element resolves the HIT-TESTED point, not the rect midpoint", async () => {
  const target = new FakeElement("button", { "data-testid": "save" }, {
    left: 100, top: 200, right: 200, bottom: 240,
  });
  // elementFromPoint vouches for the target at its centre.
  const h = harness({ hitTest: () => target });

  const result = await h.controller.point(target);

  assert.equal(result.ok, true);
  assert.equal(result.receives_events, true);
  assert.equal(result.actionability_attested, true);
  assert.equal(result.occluded_by, null);
  // The centre of {100,200,200,240} is {150,220}.
  assertPoint(result.clickable_center, { x: 150, y: 220 }, "clickable_center");
  // The cursor was actually drawn at that hit-tested point.
  const arrival = h.renders.filter((r) => r.visible && r.phase === "arrive").pop();
  assert.ok(arrival, "an arrival render must occur");
  assertPoint(arrival.point, { x: 150, y: 220 }, "arrival render point");
});

test("when elementFromPoint returns a DIFFERENT element the result reports occlusion, not success", async () => {
  // This is the documented failure verbatim: a row fully inside the viewport
  // whose centre hit-tests to the page's sticky header.
  const target = new FakeElement("input", { "aria-label": "row checkbox" }, {
    left: 30, top: 165, right: 44, bottom: 175,
  });
  const stickyHeader = new FakeElement("section", { "data-testid": "card-back-sticky-header" }, {
    left: 0, top: 0, right: 1024, bottom: 200,
  });
  const h = harness({ hitTest: () => stickyHeader });

  const result = await h.controller.point(target);

  assert.equal(result.ok, false, "an occluded target must NOT report success");
  assert.equal(result.code, "target_occluded");
  // exists / on_screen / receives_events stay three separate booleans.
  assert.equal(result.exists, true);
  assert.equal(result.on_screen, true);
  assert.equal(result.receives_events, false);
  assert.equal(result.occluded_by.tag_name, "section");
  assert.equal(result.occluded_by.target_label, "card-back-sticky-header");
  assert.equal(result.occluded_by.is_overlay_pill, false);
  // No clickable_center is minted for a point nothing vouched for.
  assert.equal(result.clickable_center, undefined);
  // And critically: the cursor was never drawn. Drawing it would be a
  // confident lie pointing at a spot a click never reaches.
  assert.equal(h.renders.filter((r) => r.visible).length, 0);
});

test("an off-screen target is scrolled into view BEFORE the cursor animates", async () => {
  const target = new FakeElement("button", { id: "far-below" }, {
    left: 100, top: 5000, right: 200, bottom: 5040,
  });
  const h = harness({ hitTest: () => target });
  h.adopt(target);

  const result = await h.controller.point(target);

  assert.equal(result.scrolled_into_view, true, "the target must be scrolled into view");
  assert.equal(target.scrollIntoViewCalls.length, 1);
  // block:"center" — NOT the default top-alignment, which parks the target
  // under a sticky header and manufactures the very occlusion we detect.
  assert.equal(target.scrollIntoViewCalls[0].block, "center");
  assert.equal(result.ok, true);
  assert.equal(result.on_screen, true);
  // The scroll happened before any render: the user never sees the cursor
  // pointing at somewhere off-screen.
  assert.ok(h.renders.length > 0, "the cursor must render after the scroll");
  const firstVisible = h.renders.find((r) => r.visible);
  assert.ok(
    firstVisible.point.y < 768,
    `the first drawn point must be inside the viewport, got y=${firstVisible.point.y}`,
  );
});

test("with prefers-reduced-motion no travel animation runs but arrival feedback still appears", async () => {
  const first = new FakeElement("button", { id: "a" }, { left: 0, top: 0, right: 20, bottom: 20 });
  const second = new FakeElement("button", { id: "b" }, { left: 500, top: 400, right: 520, bottom: 420 });
  const h = harness({ reducedMotion: true, hitTest: (x, y) => (y < 100 ? first : second) });

  await h.controller.point(first);
  const rendersAfterFirst = h.renders.length;
  const result = await h.controller.point(second);

  assert.equal(result.ok, true);
  assert.equal(result.reduced_motion, true);
  assert.equal(result.animated, false, "reduced motion must not run a travel animation");
  // No travel frames at all — the ONLY render for the second point is arrival.
  const secondPointRenders = h.renders.slice(rendersAfterFirst);
  assert.equal(secondPointRenders.filter((r) => r.phase === "travel").length, 0);
  // ...but arrival feedback still appears, at the right place. A reduced-motion
  // user must still learn WHERE the agent acted.
  const arrival = secondPointRenders.filter((r) => r.phase === "arrive");
  assert.equal(arrival.length, 1, "arrival feedback must still appear");
  assertPoint(arrival[0].point, { x: 510, y: 410 }, "reduced-motion arrival");
  assert.equal(arrival[0].visible, true);
});

test("a scroll/wheel/touch event during animation dismisses the cursor", async () => {
  const first = new FakeElement("button", { id: "a" }, { left: 0, top: 0, right: 20, bottom: 20 });
  const second = new FakeElement("button", { id: "b" }, { left: 600, top: 600, right: 620, bottom: 620 });
  const h = harness({ hitTest: (x, y) => (y < 100 ? first : second) });

  // First point establishes an origin so the second one actually travels.
  await h.controller.point(first);
  const pending = h.controller.point(second);
  await h.advance(30); // mid-flight

  // The controller must have subscribed to real user input.
  for (const type of ["scroll", "wheel", "touchstart"]) {
    assert.ok(h.listeners.has(type), `must listen for ${type}`);
  }

  h.listeners.get("wheel").handler({ type: "wheel" });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.code, "cursor_dismissed");
  assert.equal(result.dismissed_by, "wheel");
  // The cursor was actually hidden, and stays hidden.
  const last = h.renders[h.renders.length - 1];
  assert.equal(last.visible, false);
  assert.equal(h.controller.position(), null);
});

test("the controller's OWN scrollIntoView does not dismiss the cursor it is placing", async () => {
  // Regression guard for a defect the live smoke caught and the fake-DOM tests
  // could not: scrollIntoView emits a real `scroll` event, the dismissal
  // listener read it as the user taking over, and the agent's own scroll
  // cancelled the agent's own cursor. Here the fake DOM fires that scroll event
  // explicitly, the way a browser does.
  const first = new FakeElement("button", { id: "a" }, { left: 0, top: 0, right: 20, bottom: 20 });
  const target = new FakeElement("button", { id: "far" }, {
    left: 100, top: 5000, right: 200, bottom: 5040,
  });
  const h = harness({ hitTest: (x, y) => (y < 100 ? first : target) });
  h.adopt(target);
  // Make scrollIntoView emit its scroll event the way a real browser does:
  // ASYNCHRONOUSLY, and repeatedly, as the scroll settles. Firing it once and
  // synchronously is what made an earlier version of this test vacuous — there
  // was no animation in flight yet for the dismissal to cancel. A real browser
  // also keeps emitting settling events well past any fixed grace window, which
  // is why suppression is by scroll POSITION rather than by elapsed time.
  target.scrollIntoView = function scrollIntoViewWithEvent(options) {
    FakeElement.prototype.scrollIntoView.call(this, options);
    for (const delay of [20, 60, 140, 300]) {
      h.scheduleRaw(() => h.listeners.get("scroll")?.handler({ type: "scroll" }), delay);
    }
  };

  await h.controller.point(first);
  const pending = h.controller.point(target);
  await h.advance(400);
  const result = await pending;

  assert.equal(result.ok, true, `self-scroll must not dismiss: got ${result.code}`);
  assert.equal(result.scrolled_into_view, true);
  assert.notEqual(result.code, "cursor_dismissed");

  // ...but a genuine user scroll — one that moves the page somewhere the
  // controller did not put it — must STILL dismiss. Without this direction the
  // fix could simply have disabled scroll-dismissal altogether and passed.
  const second = new FakeElement("button", { id: "b" }, { left: 600, top: 600, right: 620, bottom: 620 });
  const h2 = harness({ hitTest: (x, y) => (y < 100 ? first : second) });
  await h2.controller.point(first);
  const flying = h2.controller.point(second);
  await h2.advance(30);
  h2.userScroll(400);
  const dismissed = await flying;
  assert.equal(dismissed.ok, false, "a user scroll must still dismiss");
  assert.equal(dismissed.code, "cursor_dismissed");
  assert.equal(dismissed.dismissed_by, "scroll");
});

test("chained points originate from the previous position", async () => {
  const first = new FakeElement("button", { id: "a" }, { left: 0, top: 0, right: 20, bottom: 20 });
  const second = new FakeElement("button", { id: "b" }, { left: 600, top: 400, right: 620, bottom: 420 });
  const h = harness({ hitTest: (x, y) => (y < 100 ? first : second) });

  const firstResult = await h.controller.point(first);
  // The first point has no previous position to chain from.
  assert.equal(firstResult.chained_from, null);
  assertPoint(h.controller.position(), { x: 10, y: 10 }, "position after first point");

  const pending = h.controller.point(second);
  await h.advance(200);
  const secondResult = await pending;

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.animated, true);
  // It travelled FROM where the first point landed — a continuous journey.
  assertPoint(secondResult.chained_from, { x: 10, y: 10 }, "chained_from");

  const travel = h.renders.filter((r) => r.phase === "travel");
  assert.ok(travel.length > 1, "a chained move must render intermediate frames");
  // The first travel frame starts at the previous position, not at the target
  // and not at some arbitrary origin.
  assert.ok(
    travel[0].point.x < 100 && travel[0].point.y < 100,
    `travel must begin near the previous position, got ${JSON.stringify(travel[0].point)}`,
  );
  // ...and it ends on the new target.
  assertPoint(secondResult.clickable_center, { x: 610, y: 410 }, "second clickable_center");
  assertPoint(h.controller.position(), { x: 610, y: 410 }, "position after chained point");
});

test("pointing at an element the overlay pill itself covers reports the pill as the occluder", async () => {
  const target = new FakeElement("button", { "data-testid": "submit" }, {
    left: 900, top: 700, right: 1000, bottom: 740,
  });
  // The actions.json overlay host, and a child of it that is what actually
  // hit-tests — the occluder is usually a descendant, not the host itself.
  const pillHost = new FakeElement("div", { id: "__actions_json_menu_overlay_host" }, {
    left: 860, top: 660, right: 1024, bottom: 768,
  });
  const pillInner = pillHost.appendChild(
    new FakeElement("div", { "data-testid": "agent-pill" }, { left: 870, top: 670, right: 1010, bottom: 760 }),
  );
  const h = harness({ hitTest: () => pillInner });

  const result = await h.controller.point(target);

  assert.equal(result.ok, false);
  assert.equal(result.code, "target_occluded");
  assert.equal(result.receives_events, false);
  // The overlay is named as the occluder specifically, so the agent knows to
  // call overlay.menu.hide rather than inventing other theories.
  assert.equal(result.occluded_by.is_overlay_pill, true);
  assert.equal(result.occluded_by.target_label, "agent-pill");
});

test("the primitive resolves through findExecutableAction (the manifest entry exists)", () => {
  // findExecutableAction looks in tools[] first, then
  // primitive_dictionary.primitives[], and throws "Unknown action" if absent.
  // Reimplement it exactly so this test fails if EITHER registration is missing.
  const findExecutableAction = (actions, name) => {
    const declaredTool = actions.tools?.find((tool) => tool.name === name);
    if (declaredTool) return declaredTool;
    const primitive = actions.primitive_dictionary?.primitives?.find((entry) => entry.name === name);
    if (!primitive || primitive.support === "unsupported") return null;
    return primitive;
  };

  const tool = manifest.tools.find((entry) => entry.name === "overlay.cursor.point");
  assert.ok(tool, "overlay.cursor.point must be declared in tools[]");
  assert.equal(tool.support, "supported");
  assert.equal(tool.input_schema.type, "object");
  assert.deepEqual(tool.input_schema.required, ["locator"]);
  assert.equal(tool.x_actions.handler, "overlay.cursor.point");

  const primitive = manifest.primitive_dictionary.primitives.find(
    (entry) => entry.name === "overlay.cursor.point",
  );
  assert.ok(primitive, "overlay.cursor.point must be declared in primitive_dictionary.primitives[]");
  assert.equal(primitive.support, "supported");
  assert.ok(primitive.summary?.trim(), "supported primitives must carry a summary");
  assert.equal(primitive.input_schema.type, "object");

  assert.ok(findExecutableAction(manifest, "overlay.cursor.point"));

  // And the dispatch branch exists, so a resolved action actually runs. Both
  // dispatch paths converge on executeAction, so a content-realm primitive
  // needs no BRIDGE_BACKGROUND_ACTION_NAMES entry — but it does need this.
  assert.ok(
    contentSource.includes('message.name === "overlay.cursor.point"'),
    "executeAction must route overlay.cursor.point",
  );
  assert.ok(
    contentSource.includes("overlayCursorPoint(message.arguments || {})"),
    "the dispatch branch must call the handler",
  );
});

test("a target that is not in the document reports target_not_found without drawing", async () => {
  const target = new FakeElement("button", { id: "detached" }, { left: 10, top: 10, right: 30, bottom: 30 });
  const h = harness({ hitTest: () => target, documentContains: () => false });

  const result = await h.controller.point(target);

  assert.equal(result.ok, false);
  assert.equal(result.code, "target_not_found");
  assert.equal(result.exists, false);
  assert.equal(result.on_screen, false);
  assert.equal(result.receives_events, false);
  assert.equal(h.renders.filter((r) => r.visible).length, 0);
});

test("the npm-bridge dictionary mirror stays byte-identical to the packaged manifest", async () => {
  const packaged = await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8");
  const mirror = await readFile(
    new URL("../../../adapters/npm-bridge/dictionary/overlay.actions.json", import.meta.url),
    "utf8",
  );
  assert.equal(mirror, packaged, "adapters/npm-bridge/dictionary mirror must match byte-for-byte");
});
