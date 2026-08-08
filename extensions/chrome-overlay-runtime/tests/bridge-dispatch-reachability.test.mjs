import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, "..");

// A primitive reaches the browser by TWO different paths, and implementing one
// does not implement the other:
//
//   HOSTED AGENT  -> executeLocalHostedToolCall (background.js)
//   DIRECT MCP    -> routeBridgeItemToTab, which forwards to content.js
//                    executeAction UNLESS the name is in
//                    BRIDGE_BACKGROUND_ACTION_NAMES
//
// A background-only primitive missing from that set is advertised by the bridge,
// routed by the bridge, present in the packaged extension, and STILL answers
// `handler_failed: No handler implemented` — because the direct call falls
// through to a content script that has no handler for it.
//
// corpus.search shipped that way in 0.1.246 (found by a tester). Every other guard
// passed: the catalog test proved advertisement, the packaging test proved the
// module ships, and my live smoke proved the handler runs — because the smoke
// called executeLocalHostedToolCall directly and never exercised the bridge
// path. Three green instruments, one unreachable primitive.
//
// This asserts the PROPERTY (a background-only primitive is reachable from BOTH
// paths) rather than a name list, so it keeps working as primitives are added.
test("every background-only primitive is reachable from the direct MCP path", () => {
  const background = readFileSync(join(extensionRoot, "src", "background.js"), "utf8");
  const content = readFileSync(join(extensionRoot, "src", "content.js"), "utf8");

  const setMatch = background.match(
    /BRIDGE_BACKGROUND_ACTION_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(
    setMatch,
    "could not find BRIDGE_BACKGROUND_ACTION_NAMES — the regex has drifted from " +
      "background.js and this guard would pass vacuously",
  );
  const interceptedNames = new Set(
    [...setMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );

  // Primitives dispatched inside executeLocalHostedToolCall by an explicit
  // `call.name === "..."` comparison. These run in the service worker and have
  // no content-script implementation by construction.
  const hostedBody = background.slice(background.indexOf("const executeLocalHostedToolCall"));
  const backgroundHandled = new Set(
    [...hostedBody.matchAll(/call\.name === "([a-z0-9_.]+)"/g)].map((match) => match[1]),
  );
  assert.ok(
    backgroundHandled.size > 0,
    "found no background-handled primitives — the scan has drifted and this " +
      "guard is asserting nothing",
  );

  const unreachable = [...backgroundHandled].filter((name) => {
    if (interceptedNames.has(name)) return false;
    // If content.js implements it too, the fall-through is harmless.
    return !content.includes(`"${name}"`);
  });

  assert.deepEqual(
    unreachable,
    [],
    `these primitives are handled ONLY in background.js but are not in ` +
      `BRIDGE_BACKGROUND_ACTION_NAMES, so a direct MCP call falls through to ` +
      `content.js and returns handler_failed: ${unreachable.join(", ")}`,
  );

  // Interception is only HALF the path. BRIDGE_BACKGROUND_ACTION_NAMES routes
  // the call to executeBackgroundHostedToolCall, which returns null for a name
  // it does not know — and the caller treats null as an ERROR with
  // output:undefined. So a name in the set with no handler in that function
  // swaps `handler_failed` for a different failure: the symptom moves, the
  // primitive is still unreachable.
  //
  // Assert each intercepted-and-background-handled primitive is actually
  // answered there, whether directly or by delegating to
  // executeLocalHostedToolCall.
  const executorStart = background.indexOf("const executeBackgroundHostedToolCall");
  assert.ok(executorStart > 0, "could not find executeBackgroundHostedToolCall");
  const executorBody = background.slice(executorStart, background.indexOf("\n};", executorStart));
  const answeredByExecutor = new Set(
    [...executorBody.matchAll(/call\.name === "([a-z0-9_.]+)"/g)].map((match) => match[1]),
  );

  const interceptedButUnanswered = [...backgroundHandled].filter(
    (name) => interceptedNames.has(name) && !answeredByExecutor.has(name),
  );
  assert.deepEqual(
    interceptedButUnanswered,
    [],
    `these primitives are INTERCEPTED for the background path but ` +
      `executeBackgroundHostedToolCall has no branch for them, so it returns ` +
      `null and the caller reports an error with no output: ` +
      `${interceptedButUnanswered.join(", ")}`,
  );
});
