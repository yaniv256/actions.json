import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentSource = fs.readFileSync(path.join(here, "../src/content.js"), "utf8");

test("state_read atomically activates a content-realm graph snapshot", () => {
  assert.match(contentSource, /import\(chrome\.runtime\.getURL\("src\/agent\/projection-snapshot-store\.mjs"\)\)/);
  assert.match(contentSource, /activateGraph: \(\{ graph \}\) => \{/);
  assert.match(contentSource, /const activated = store\.activate\(\{/);
  assert.match(contentSource, /projectionSnapshotAuthorities\.set\(activated\.snapshot_id, authority\)/);
  assert.match(contentSource, /snapshot_id: activated\.snapshot_id/);
  assert.match(contentSource, /navigation_ready: true/);
});

test("content realm owns the exact bounded navigate and search message routes", () => {
  for (const route of [
    "actions-json:execute-projection-navigate",
    "actions-json:execute-projection-search",
    "actions-json:prepare-projection-semantic-search",
    "actions-json:finalize-projection-semantic-search",
  ]) {
    assert.ok(contentSource.includes(`message?.type === "${route}"`), `missing ${route}`);
  }
  assert.match(contentSource, /createCursor\(\{/);
  assert.match(contentSource, /resolveCursor\(\{ authority, handle: message\.cursor \}\)/);
  assert.match(contentSource, /searchLexicalIndex\(snapshot\.graph, args\.query/);
  assert.match(contentSource, /args\.operation \|\| \(args\.node_ref \? "node" : "roots"\)/);
  assert.match(contentSource, /mode === "neighbors" \|\| mode === "traverse"/);
  assert.match(contentSource, /measure_filter is not supported by this retrieval revision/);
  assert.match(contentSource, /slice\(0, 160\)/, "field evidence must be snippet-bounded");
  assert.match(contentSource, /projectionNavigationUrl/,
    "search results must surface a safe logical target URL without a second broad projection");
  assert.match(contentSource, /\['http:', 'https:'\]\.includes\(resolved\.protocol\)/,
    "logical navigation hints must reject privileged URL schemes");
  assert.match(contentSource, /match_kind: match\.match_kind/,
    "exact logical identity proof must survive the content-realm boundary");
  assert.match(contentSource, /projection_answer_too_large/);
  assert.match(contentSource, /__semantic_ranked_matches/);
  assert.match(contentSource, /pageProjectionResults\(\{/);
  assert.match(contentSource, /semantic_provider_unavailable/,
    "content integration must reject, not improvise, a semantic provider");
});

test("semantic preparation is internal, bounded, and returns policy candidates without credentials", () => {
  assert.match(contentSource, /const prepareProjectionSemanticSearch/);
  assert.match(contentSource, /candidates\.length >= 100_000/);
  assert.match(contentSource, /candidateBytes \+ bytes > 8_000_000/);
  for (const field of ["snapshot_id", "semantic_namespace", "projection_name", "catalog_revision", "lexical_result", "candidates", "coverage"]) {
    assert.match(contentSource, new RegExp(`${field}:`), `missing internal semantic field ${field}`);
  }
  assert.doesNotMatch(contentSource, /prepareProjectionSemanticSearch[\s\S]{0,12000}(apiKey|Authorization|loadOpenAiApiKey)/);
});

test("snapshot authority and SPA cleanup fail closed", () => {
  for (const field of ["runtime_id", "tab_id", "navigation_epoch", "projection", "catalog_revision"]) {
    assert.match(contentSource, new RegExp(`${field}:`), `missing authority field ${field}`);
  }
  assert.match(contentSource, /snapshot_authority_mismatch/);
  assert.match(contentSource, /cleanupNavigation\(\{/);
  assert.match(contentSource, /cleanupTab\(\{/);
  assert.match(contentSource, /window\.addEventListener\("popstate", advanceProjectionNavigationEpoch\)/);
  assert.match(contentSource, /window\.addEventListener\("hashchange", advanceProjectionNavigationEpoch\)/);
});

test("legacy summary, diff, marker, cache, and postcondition routes remain present", () => {
  for (const contract of [
    "executeStatePostcondition",
    "executeStateDiff",
    "registerStateMarkers",
    "stateProjectionSnapshots",
    "projection_cache",
    "summary_name",
  ]) {
    assert.ok(contentSource.includes(contract), `legacy state path lost ${contract}`);
  }
});
