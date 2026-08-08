/**
 * The cost meter is opt-in (U7).
 *
 * Before this, `applyCostMeter` ended in a bare `footer.hidden = false`, so a
 * running dollar figure appeared on every page an agent touched, with no way to
 * turn it off.
 *
 * WHAT THIS TEST ACTUALLY READS
 * -----------------------------
 * content.js is an IIFE content script, not a module, so it cannot be imported
 * and its gate cannot be called directly. Reimplementing the gate here would
 * test a copy and stay green while the shipped file regressed — the exact
 * vacuous-test shape this repo keeps catching. So this test reads the SHIPPED
 * SOURCE and asserts the structural property: the visible branch is reachable
 * only past the showCost check, and the default is false in both definitions.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_STORAGE_KEY,
  shouldShowCostMeter,
} from "../src/agent/overlay-settings-store.mjs";

const contentPath = path.join(
  path.resolve(new URL("..", import.meta.url).pathname),
  "src/content.js",
);

test("the cost meter is hidden by default", () => {
  assert.equal(DEFAULT_OVERLAY_SETTINGS.showCost, false);
  assert.equal(shouldShowCostMeter(undefined), false);
  assert.equal(shouldShowCostMeter({}), false);
  // A half-written blob must not reveal spend.
  assert.equal(shouldShowCostMeter({ showCost: "true" }), false);
  assert.equal(shouldShowCostMeter({ showCost: 1 }), false);
  // And the one case that shows it.
  assert.equal(shouldShowCostMeter({ showCost: true }), true);
});

test("applyCostMeter reveals the footer only past the showCost gate", async () => {
  const source = await readFile(contentPath, "utf8");
  const start = source.indexOf("const applyCostMeter =");
  assert.ok(start > 0, "applyCostMeter must exist in content.js");
  const body = source.slice(start, source.indexOf("const showCostMeter =", start));

  const gateIndex = body.indexOf("if (!overlayShowCost)");
  const revealIndex = body.indexOf("footer.hidden = false");
  assert.ok(gateIndex > 0, "applyCostMeter must consult the showCost preference");
  assert.ok(revealIndex > 0, "applyCostMeter must still be able to reveal the footer");
  assert.ok(
    gateIndex < revealIndex,
    "the showCost gate must precede the reveal, or the footer shows regardless",
  );
  // The gate must actually hide, not merely early-return past a stale footer.
  const gateBody = body.slice(gateIndex, revealIndex);
  assert.match(gateBody, /footer\.hidden = true/, "the gate must hide the footer when off");
  assert.match(gateBody, /return false/, "the gate must stop before the reveal");
});

test("content.js reads the same storage key the popup writes", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.ok(
    source.includes(`"${OVERLAY_SETTINGS_STORAGE_KEY}"`),
    "content.js must read the shared overlay settings key, or the popup toggle is inert",
  );
  assert.match(
    source,
    /overlayShowCost = settings\.showCost === true/,
    "content.js must read showCost strictly",
  );
  // A toggle that only takes effect after a page reload is not a mid-session
  // control, which is the entire reason it sits in the popup.
  assert.match(
    source,
    /chrome\.storage\.onChanged\?\.addListener/,
    "content.js must react to the toggle changing while the overlay is open",
  );
});
