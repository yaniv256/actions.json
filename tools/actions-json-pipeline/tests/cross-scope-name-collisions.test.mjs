import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import test from "node:test";

// The two storage scopes MERGE — private does not shadow public. The bridge then resolves the
// merged catalog, and it treats the two kinds of name collision in OPPOSITE ways:
//
//   duplicate ACTION name      -> storage_scope_precedence_rank picks a winner
//                                 (private 0 > shared 1 > public 2 > unscoped 3)
//                                 `lib.rs`, under `if matches.len() > 1`
//   duplicate PROJECTION name  -> 409 CONFLICT `state_projection_ambiguous`
//                                 `lib.rs:5447`, under the SAME `if matches.len() > 1`
//
// So a duplicate action is a deliberate override; a duplicate projection is a hard runtime
// failure on every `state_read` of that name, and routing by runtime_id does not help — the
// collision is in the catalog, not the routing.
//
// This bit for real (2026-07-09): a private Trello map seeded by `cp`-ing the whole public map
// duplicated 97 tools AND 3 projections; every `trello.board` read 409'd. The fix was to make the
// private map a MINIMAL diff (surface header + only the new tool). That fix is a discipline, and
// a discipline is not a check — hence this test.
//
// It asserts the PROPERTY, not a list of the maps we happen to know about today.

function storedMaps() {
  try {
    return execSync("ls /home/agent-zara/actions.json.storage/scopes/*/sites/*/*/actions.json")
      .toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function bySurface(maps) {
  const surfaces = new Map(); // "host/surface" -> { actions: Map<name,[scope]>, projections: Map<name,[scope]> }
  for (const path of maps) {
    const [scope, , host, surface] = path.split("/scopes/")[1].split("/");
    const key = `${host}/${surface}`;
    let map;
    try { map = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (!surfaces.has(key)) surfaces.set(key, { actions: new Map(), projections: new Map() });
    const entry = surfaces.get(key);
    for (const tool of map.tools ?? []) {
      if (!entry.actions.has(tool.name)) entry.actions.set(tool.name, []);
      entry.actions.get(tool.name).push(scope);
    }
    for (const projection of map.state_projections ?? []) {
      const name = projection.name ?? "?";
      if (!entry.projections.has(name)) entry.projections.set(name, []);
      entry.projections.get(name).push(scope);
    }
  }
  return surfaces;
}

// A duplicate projection name across scopes 409s EVERY read of that name. There is no
// precedence path for projections, so this can never be an intentional override.
test("no state_projection name is declared in more than one scope for the same surface", (t) => {
  const maps = storedMaps();
  if (maps.length === 0) return t.skip("Sibling actions.json.storage checkout is not available.");

  const collisions = [];
  for (const [surface, { projections }] of bySurface(maps)) {
    for (const [name, scopes] of projections) {
      if (scopes.length > 1) collisions.push(`${surface}  projection "${name}"  in ${scopes.join(" + ")}`);
    }
  }

  assert.deepEqual(
    collisions,
    [],
    "each of these returns 409 state_projection_ambiguous on EVERY state_read of that name — " +
      "unlike a duplicate action name, a duplicate projection has no precedence path:\n  " +
      collisions.join("\n  "),
  );
});

// A duplicate ACTION name is legal — that is what private-over-public override means. But it is
// only ever intentional as a MINIMAL diff. A private map that re-declares most of public is a
// full copy, which is how the projection collisions above get created in the first place.
test("no private map re-declares the bulk of its public counterpart (that is a full copy, not an override)", (t) => {
  const maps = storedMaps();
  if (maps.length === 0) return t.skip("Sibling actions.json.storage checkout is not available.");

  const suspects = [];
  for (const [surface, { actions }] of bySurface(maps)) {
    const publicNames = [...actions].filter(([, s]) => s.includes("public")).length;
    const overridden = [...actions].filter(([, s]) => s.includes("public") && s.includes("private")).length;
    if (publicNames >= 3 && overridden > publicNames / 2) {
      suspects.push(`${surface}  private re-declares ${overridden}/${publicNames} public actions`);
    }
  }

  assert.deepEqual(
    suspects,
    [],
    "a private map is a MINIMAL diff over public (surface header + the tool(s) being added or " +
      "overridden), never a copy — a copy duplicates every projection name too:\n  " + suspects.join("\n  "),
  );
});
