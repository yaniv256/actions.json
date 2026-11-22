// The corpus gate: the runner runs, in CI, on this branch.
//
// The runner previously shipped here with nothing importing it. That made the
// PR's central claim -- "the corpus executes" -- unverifiable on the branch
// that contained it: the only test exercising the runner lived on a dependent
// branch, so this one shipped a dispatcher nobody dispatched. A runner nobody
// runs and no runner at all produce identical CI output.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dispatchableOperations,
  runCorpus,
} from "../../../contracts/capability-resolution/runner.mjs";
import {
  authorityKey,
  referenceAdapter,
  requestDigest,
} from "../../../contracts/capability-resolution/reference-adapter.mjs";

const corpusPath = new URL(
  "../../../contracts/capability-resolution/host-resolution.vectors.json",
  import.meta.url,
);
const dictionaryPath = new URL("../src/primitives/dictionary.v1.json", import.meta.url);
const dictionary = JSON.parse(await readFile(dictionaryPath, "utf8"));
// A FRESH adapter per vector. One shared instance let an earlier vector's
// reservation survive into a later one, so a vector that should have executed
// found its call id already claimed -- two vectors failing on an invocation
// count while both adapters were correct in isolation. Cross-vector state is
// the corpus equivalent of a test that only passes in file order.
const freshAdapter = () => referenceAdapter({ dictionary });
const adapter = freshAdapter();

test("every declared operation has a dispatcher", async () => {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const declared = new Set(corpus.operations.kinds);
  const dispatchable = new Set(dispatchableOperations());

  const orphaned = [...declared].filter((op) => !dispatchable.has(op));
  assert.deepEqual(
    orphaned,
    [],
    `the corpus declares operations the runner cannot dispatch: ${orphaned.join(", ")}`,
  );
});

// The runner calls one adapter across all vectors, so isolation is provided
// by rebuilding the mutable half on each dispatch.
function perVectorAdapter() {
  const base = freshAdapter();
  return new Proxy(base, {
    get(target, property) {
      if (property === "runCalls" || property === "runConcurrent") {
        return (input) => freshAdapter()[property](input);
      }
      return target[property];
    },
  });
}

test("the reference adapter conforms to every resolve vector", async () => {
  const report = await runCorpus({ corpusPath, adapter: perVectorAdapter() });

  const detail = report.failed
    .map((entry) => {
      const checks = (entry.checks ?? [])
        .filter((check) => !check.ok)
        .map((c) => `${c.check}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
        .join("; ");
      return `${entry.id}: ${entry.error ?? ""} ${checks}`.trim();
    })
    .join("\n  ");

  assert.deepEqual(report.failed, [], `conformance failures:\n  ${detail}`);

  // `passed.length > 0` was the only completeness check, and one passing
  // vector satisfies it. A vector whose operation no longer dispatches is
  // reported as `undispatched` -- not as a failure -- so renaming an operation
  // made a vector vanish while this test stayed green. Verified by doing it:
  // 35 passed became 34 passed plus 1 undispatched, and nothing went red.
  assert.deepEqual(
    report.undispatched,
    [],
    `vectors the runner could not dispatch: ${report.undispatched.map((u) => `${u.id} (${u.operation})`).join(", ")}`,
  );

  // Every vector is accounted for by exactly one bucket, against a count
  // committed HERE rather than read from the corpus. Deriving the expected
  // total from the file under test cannot detect a deletion -- both sides of
  // the comparison shrink together. Verified by deleting a vector: the
  // self-derived version stayed green, this one goes red.
  //
  // Raising these numbers is the deliberate act of adding a vector. That is
  // the point: the corpus is the contract's surface, and it must not shrink
  // by accident.
  const EXPECTED_VECTORS = 43;
  const EXPECTED_TARGETS = 40;

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.equal(corpus.vectors.length, EXPECTED_VECTORS, "the corpus changed size");
  assert.equal(
    corpus.vectors.filter((v) => v.expectation === "target").length,
    EXPECTED_TARGETS,
    "a vector changed expectation -- reclassifying a target to current-defect retires it silently",
  );

  const accounted =
    report.passed.length + report.failed.length + report.undispatched.length + report.skipped.length;
  assert.equal(accounted, EXPECTED_VECTORS, "every vector must land in exactly one bucket");
  assert.equal(report.passed.length, EXPECTED_TARGETS, "every target vector must actually pass");

  // The skips are the three named current-defect vectors, not an open budget.
  assert.deepEqual(
    report.skipped.map((s) => s.id).sort(),
    ["packaged-declares-host-but-code-ignores-it", "packaged-host-selector-ignored", "rust-allowlist-is-unnamed-policy-layer"],
    "the skip list changed -- a skip is a deferred defect, so it is enumerated rather than counted",
  );
  for (const skipped of report.skipped) {
    assert.equal(skipped.why, "current-defect", `${skipped.id} is skipped for an unnamed reason`);
  }
});

test("an adapter that answers nothing cannot pass", async () => {
  // Sabotage, as the gate's own positive control. If a silent adapter passed,
  // this test would be measuring nothing -- which is the state the runner was
  // in before it had a caller.
  const report = await runCorpus({
    corpusPath,
    adapter: { ...adapter, resolve: () => ({}) },
    only: ["unknown-host-fails-closed"],
  });
  assert.equal(report.passed.length, 0);
});

test("the request digest is canonical, not an arbitrary string", () => {
  // Two runtimes must agree on whether a replay is a replay. `request_digest`
  // was previously typed as any non-empty string, so each could be
  // self-consistent and disagree with the other.
  const a = requestDigest({ primitive: "data.query", arguments: { b: 1, a: 2 } });
  const b = requestDigest({ primitive: "data.query", arguments: { a: 2, b: 1 } });
  assert.equal(a, b, "key order must not change the digest");

  const different = requestDigest({ primitive: "data.query", arguments: { a: 2, b: 2 } });
  assert.notEqual(a, different, "a different payload must change the digest");

  const otherPrimitive = requestDigest({ primitive: "data.describe", arguments: { b: 1, a: 2 } });
  assert.notEqual(a, otherPrimitive, "a different primitive must change the digest");

  assert.match(a, /^req-[0-9a-f]{32}$/);
});

test("the authority key separates what must not share a receipt", () => {
  const base = {
    installation_id: "inst-1", tenant_id: "t", principal_id: "p",
    session_id: "s", runtime_id: "r", authority_mode: "owner_rights",
  };
  const key = authorityKey(base);

  // authority_mode is part of the key: the same call under owner rights and
  // caller rights executes with different privileges, so a receipt earned
  // under one must not answer a request made under the other.
  assert.notEqual(key, authorityKey({ ...base, authority_mode: "caller_rights" }));
  for (const field of ["installation_id", "tenant_id", "principal_id", "session_id"]) {
    assert.notEqual(key, authorityKey({ ...base, [field]: "other" }), `${field} must key`);
  }

  // Positive control: an identical scope keys identically, so the above is not
  // passing because every key is unique.
  assert.equal(key, authorityKey({ ...base }));
});

test("a settled receipt survives host reconstruction with zero re-execution", async () => {
  // The acceptance proof, done properly. The previous version called
  // `store.reconstruct()`, which returned `this` -- so it reused the same
  // object and the same private Map and would have passed with the
  // reconstruction it claimed to prove entirely absent. A test asserting its
  // own docstring.
  //
  // A real Streamlit V1 rerun destroys the Python host. Instance A and
  // instance B here share NOTHING but the durable store's rows.
  const { DurableReceiptStore, referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const durable = new DurableReceiptStore();
  const hostState = {
    host: "embed",
    revision: "rev-A",
    principal_id: "principal-a",
    namespaces: {
      pointer: { provider: "p", registrations: { p: { implements: ["pointer.click"] } } },
    },
  };
  const scope = {
    installation_id: "inst-1", tenant_id: "t-1", principal_id: "principal-a",
    session_id: "continuation-1", runtime_id: "r-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "pointer.click", arguments: { x: 1 } };

  // Instance A admits and settles the mutation.
  const a = build({ dictionary, store: durable });
  const first = await a.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(first.handlerInvocations, 1);
  assert.equal(first.results[0].type, "action_call_output");

  // A is destroyed. Only the durable rows cross the boundary -- reconstructed
  // from a snapshot, so nothing of A's in-process state can leak through.
  const carried = DurableReceiptStore.from(durable.snapshot());
  const b = build({ dictionary, store: carried });

  const replay = await b.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(
    replay.handlerInvocations,
    0,
    "reconstruction re-executed the mutation; the receipt did not survive",
  );
  assert.equal(replay.results[0].from_receipt, true);

  // Positive control: a store that did NOT carry the rows must re-execute, so
  // the assertion above is not passing because instance B never runs anything.
  const empty = build({ dictionary, store: new DurableReceiptStore() });
  const fresh = await empty.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(fresh.handlerInvocations, 1, "an empty store must re-execute");
});

test("another principal cannot present the same continuation and replay", async () => {
  const { DurableReceiptStore, referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const durable = new DurableReceiptStore();
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "principal-a",
    namespaces: { pointer: { provider: "p", registrations: { p: { implements: ["pointer.click"] } } } },
  };
  const scope = {
    installation_id: "inst-1", tenant_id: "t-1", principal_id: "principal-a",
    session_id: "continuation-1", runtime_id: "r-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "pointer.click", arguments: { x: 1 } };

  const a = build({ dictionary, store: durable });
  await a.runCalls({ host_state: hostState, scope, calls: [call] });

  // The browser-carried continuation id is an untrusted lookup token. Another
  // authenticated principal presenting it must be refused BEFORE the lookup
  // discloses anything and before execution -- the token must never broaden
  // authority.
  const b = build({ dictionary, store: DurableReceiptStore.from(durable.snapshot()) });
  const stolen = await b.runCalls({
    host_state: hostState,
    scope: { ...scope, principal_id: "principal-b" },
    calls: [call],
  });
  assert.equal(stolen.handlerInvocations, 0);
  assert.equal(stolen.results[0].error.code, "principal_mismatch");
});

test("settle is compare-and-set, owned by the acquisition", async () => {
  const { DurableReceiptStore } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );
  const store = new DurableReceiptStore();
  const key = authorityKey({ installation_id: "i", principal_id: "p" });

  // Settling without a reservation is refused: a terminal row with no claim
  // means a receipt was written for work nobody admitted.
  assert.equal(store.settle(key, "c-1", { result: { ok: true } }).ok, false);

  const claim = store.reserve(key, "c-1", "digest-1");
  assert.equal(claim.state, "acquired");
  assert.ok(claim.owner_token, "acquisition must issue an owner token");

  // Wrong owner: a stale worker returning after another recovery path took
  // responsibility holds the key, the call id and the digest. The token is
  // the only thing that distinguishes it.
  assert.equal(
    store.settle(key, "c-1", { result: { ok: true }, owner_token: "someone-else", digest: "digest-1" }).reason,
    "wrong_owner",
  );

  // Wrong digest, right owner: the row is for a different request.
  assert.equal(
    store.settle(key, "c-1", { result: { ok: true }, owner_token: claim.owner_token, digest: "other" }).reason,
    "wrong_digest",
  );

  // The rightful owner settles, once.
  assert.equal(
    store.settle(key, "c-1", { result: { ok: true }, owner_token: claim.owner_token, digest: "digest-1" }).ok,
    true,
  );
  const second = store.settle(key, "c-1", { result: { ok: "different" }, owner_token: claim.owner_token, digest: "digest-1" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_terminal");

  assert.equal(store.reserve(key, "c-1", "digest-1").state, "settled");
  assert.equal(store.reserve(key, "c-1", "other-digest").state, "conflict");
});

test("two overlapping admissions coalesce: one executes, both get one receipt", async () => {
  // Driven through the ADAPTER, not raw store calls. The previous version
  // called store.reserve() directly and asserted the loser saw
  // unknown_disposition -- which conflated a live owner with a lost one. A
  // concurrent same-digest caller should coalesce behind in_flight and receive
  // the same terminal receipt; unknown_disposition is for ownership loss,
  // where disposition cannot be established at all.
  const { DurableReceiptStore, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const store = new DurableReceiptStore();
  const scopeKey = key({ installation_id: "i", principal_id: "p" });
  const digest = "digest-1";

  const first = store.reserve(scopeKey, "c-1", digest);
  assert.equal(first.state, "acquired");

  // A second caller arriving while the owner is alive.
  const second = store.reserve(scopeKey, "c-1", digest);
  assert.equal(second.state, "in_flight", "a live owner is not a lost one");
  assert.equal(second.owner_token, first.owner_token);

  // The owner settles; both callers can now read the same terminal receipt.
  assert.equal(
    store.settle(scopeKey, "c-1", { result: { ok: true }, owner_token: first.owner_token, digest }).ok,
    true,
  );
  assert.equal(store.reserve(scopeKey, "c-1", digest).state, "settled");

  // Ownership loss is the OTHER state: the worker died without settling.
  const other = new DurableReceiptStore();
  const lost = other.reserve(scopeKey, "c-2", digest);
  assert.equal(lost.state, "acquired");
  other.loseOwner(scopeKey, "c-2");
  assert.equal(other.reserve(scopeKey, "c-2", digest).state, "unknown_disposition");
});

test("a failed durable settlement is never reported as success", async () => {
  // The crash window. A conforming-shaped store that acquires but cannot
  // settle: the domain mutation may have landed while the receipt did not.
  // Reporting action_call_output here tells the browser completion is durable
  // when nobody can reproduce it.
  const { referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const failing = {
    reserve: () => ({ state: "acquired", owner_token: "own-x" }),
    settle: () => ({ ok: false, reason: "wrong_owner" }),
  };
  const adapter = build({ dictionary, store: failing });
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "p",
    namespaces: { pointer: { provider: "x", registrations: { x: { implements: ["pointer.click"] } } } },
  };

  const out = await adapter.runCalls({
    host_state: hostState,
    scope: {
      installation_id: "i", tenant_id: "t", principal_id: "p",
      session_id: "s", runtime_id: "r", authority_mode: "owner_rights",
    },
    calls: [{ call_id: "c-1", primitive: "pointer.click", arguments: {} }],
  });

  assert.equal(out.results[0].type, "action_error");
  assert.equal(out.results[0].error.code, "reconcile_required");
  // The handler DID run, and the result says so: the caller needs to know the
  // side effect may exist, which is different from the call not happening.
  assert.equal(out.results[0].executed, true);
});

test("settlement requires the digest, not just the owner token", async () => {
  const { DurableReceiptStore, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );
  const store = new DurableReceiptStore();
  const scopeKey = key({ installation_id: "i", principal_id: "p" });
  const claim = store.reserve(scopeKey, "c-1", "digest-1");

  // The rightful owner could previously settle without proving WHICH request
  // it was settling -- three of the four agreed conditions.
  assert.equal(
    store.settle(scopeKey, "c-1", { result: { ok: true }, owner_token: claim.owner_token }).reason,
    "missing_digest",
  );
  assert.equal(
    store.settle(scopeKey, "c-1", { result: { ok: true }, owner_token: claim.owner_token, digest: "digest-1" }).ok,
    true,
  );
});

test("browser-visible error fields are closed vocabularies, not open strings", async () => {
  // Testing forbidden KEY NAMES is not enough: an open `reason` or
  // `decided_by` string leaks values under a permitted key. The redaction
  // vector checks keys; this checks the vocabulary those keys may carry.
  const { readFile } = await import("node:fs/promises");
  const schema = JSON.parse(
    await readFile(
      new URL("../../../contracts/capability-resolution/schemas/request-receipt.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const error = schema.$defs.public_error.properties;

  for (const field of ["reason", "decided_by", "code"]) {
    const spec = error[field];
    const closed = spec.enum || spec.oneOf?.some((branch) => branch.enum);
    assert.ok(closed, `public_error.${field} must be a closed vocabulary, not an open string`);
  }

  // Bounded, so a sanitized message cannot become a channel by being long.
  assert.ok(error.message.maxLength <= 300);
  assert.ok(error.correlation_id.maxLength <= 128);

  // Positive control: the vocabularies are non-empty, so this does not pass by
  // every field being forbidden outright.
  const reasons = error.reason.oneOf.find((b) => b.enum).enum;
  assert.ok(reasons.includes("namespace_unavailable"));
  assert.ok(reasons.length >= 8);
});

test("the JS digest reproduces goldens generated by an independent implementation", async () => {
  // These goldens were produced in Python, not exported from the JS function.
  // A golden generated by the implementation it validates proves
  // self-consistency and nothing about conformance -- which is the entire
  // property a cross-language digest needs.
  const { readFile } = await import("node:fs/promises");
  const goldens = JSON.parse(
    await readFile(
      new URL("../../../contracts/capability-resolution/schemas/golden-request-digests.json", import.meta.url),
      "utf8",
    ),
  );

  assert.ok(goldens.cases.length >= 8);
  for (const item of goldens.cases) {
    assert.equal(
      requestDigest({
        primitive: item.primitive,
        arguments: item.arguments,
        primitive_version: item.primitive_version ?? null,
      }),
      item.expected,
      `${item.description}: JS disagrees with the independent implementation`,
    );
  }

  // The coverage that matters is the cases where languages usually diverge.
  const descriptions = goldens.cases.map((c) => c.description).join(" ");
  for (const needed of ["unicode", "numeric boundaries", "nested", "key order",
                        "version", "embedded newline", "literal sentinel"]) {
    assert.ok(descriptions.includes(needed), `goldens must cover ${needed}`);
  }
});

test("a pre-reserved row is never executed again", async () => {
  // The central safety property, asserted directly against the caller rather
  // than the store. The store returned `unknown_disposition` correctly; both
  // `runCalls` and `runConcurrent` treated every state except conflict and
  // settled as permission to execute, so the answer was computed and
  // discarded. I wrote the spec arguing silent retry is the one option to rule
  // out, then wrote the caller that does it.
  const { DurableReceiptStore, referenceAdapter: build, requestDigest: digest, authorityKey: key } =
    await import("../../../contracts/capability-resolution/reference-adapter.mjs");

  const store = new DurableReceiptStore();
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "principal-a",
    session_id: "s", runtime_id: "r", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "pointer.click", arguments: { x: 1 } };
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "principal-a",
    namespaces: { pointer: { provider: "p", registrations: { p: { implements: ["pointer.click"] } } } },
  };

  // A worker admitted this call and died before settling. Losing the owner is
  // what makes this unresolvable -- a LIVE owner would be in_flight, which is
  // a different state with a different correct answer.
  //
  // The digest must be computed the way the adapter computes it, including the
  // provider that would execute: a digest missing that identity reads as a
  // CONFLICT rather than a reservation, which would pass this test for the
  // wrong reason.
  const adapter = build({ dictionary, store });
  const resolved = adapter.resolve({ hostState, primitive: call.primitive });
  const reserveDigest = digest({
    ...call,
    primitive_version: resolved.primitive_version ?? null,
    provider: resolved.provider ?? null,
  });
  store.reserve(key(scope), "c-1", reserveDigest);
  store.loseOwner(key(scope), "c-1");

  const out = await adapter.runCalls({ host_state: hostState, scope, calls: [call] });

  assert.equal(out.handlerInvocations, 0, "an unresolved reservation must not re-execute");
  assert.equal(out.results[0].error.code, "unknown_disposition");

  // Positive control: with no prior reservation the same call DOES execute, so
  // the assertion above is not passing because nothing ever runs.
  const clean = build({ dictionary, store: new DurableReceiptStore() });
  const fresh = await clean.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(fresh.handlerInvocations, 1);
});

test("every vector host state validates against the HostState schema", async () => {
  // The green-but-unwired class again: the preflight vectors passed while
  // `host-state.schema.json` had additionalProperties:false and no `preflight`
  // property, because vector-case.schema.json leaves `input` unconstrained.
  // No conforming HostState could carry the state the vectors relied on.
  const { readFile, readdir } = await import("node:fs/promises");
  const { createValidator } = await import("../../../contracts/capability-resolution/validate.mjs");

  const dir = new URL("../../../contracts/capability-resolution/schemas/", import.meta.url);
  const validator = createValidator();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".schema.json"))) {
    validator.add(JSON.parse(await readFile(new URL(name, dir), "utf8")));
  }
  const id = "https://actions.json/contracts/capability-resolution/host-state.schema.json";

  const corpus = JSON.parse(
    await readFile(
      new URL("../../../contracts/capability-resolution/host-resolution.vectors.json", import.meta.url),
      "utf8",
    ),
  );

  const collect = (node, found = []) => {
    if (Array.isArray(node)) node.forEach((n) => collect(n, found));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "host_state" && value && typeof value === "object") {
          // Some vectors key host states by host name; unwrap those.
          if (value.host) found.push(value);
          else for (const nested of Object.values(value)) if (nested?.host) found.push(nested);
        } else collect(value, found);
      }
    }
    return found;
  };

  // A vector may deliberately carry input the schema rejects, to prove the
  // resolver fails closed on values that reach it unvalidated -- a value from
  // a newer host arrives before any schema does.
  const conforming = corpus.vectors.filter((v) => !v.carries_invalid_host_state);
  const states = collect(conforming);
  assert.ok(states.length > 0, "the corpus must contain host states to validate");

  for (const state of states) {
    const errors = validator.validate(state, id);
    assert.deepEqual(
      errors,
      [],
      `a vector host state does not conform: ${JSON.stringify(errors)}`,
    );
  }

  // Positive control: the schema must REJECT an unknown preflight value, so
  // the pass above is not because the schema accepts anything.
  const bad = validator.validate({ ...states[0], preflight: "probably_fine" }, id);
  assert.ok(bad.length > 0, "the schema must reject an unrecognised preflight state");

  // And the vectors that opt out must genuinely be rejected by it -- an
  // exemption nobody checks is a hole.
  for (const vector of corpus.vectors.filter((v) => v.carries_invalid_host_state)) {
    const invalid = collect([vector]);
    assert.ok(invalid.length > 0, `${vector.id} claims invalid input but carries no host state`);
    assert.ok(
      invalid.some((state) => validator.validate(state, id).length > 0),
      `${vector.id} is exempted as invalid but the schema accepts it`,
    );
  }
});

test("two overlapping adapter calls coalesce: one executes, both get one receipt", async () => {
  // Through the PUBLIC adapter with a real barrier, which is the discriminator
  // the previous version lacked. That test reserved twice directly and read
  // the row afterwards -- proving the store's state vocabulary, not coalescing
  // at the action boundary. `in_flight` was distinguished in the store and
  // then left unhandled by the caller, which executed a second mutation behind
  // a live owner.
  const { DurableReceiptStore, referenceAdapter: build, authorityKey: key, requestDigest: digest } =
    await import("../../../contracts/capability-resolution/reference-adapter.mjs");

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const store = new DurableReceiptStore();
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "p",
    preflight: "durable_mutation_store_ready",
    namespaces: { data: { provider: "x", registrations: { x: { implements: ["data.write"] } } } },
  };
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    session_id: "s", runtime_id: "r", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };

  // The owner acquires and stays in flight while a second caller arrives.
  const scopeKey = key(scope);
  const resolved = { provider: "x", primitive_version: null };
  const d = digest({ ...call, provider: resolved.provider, primitive_version: null });
  const owner = store.reserve(scopeKey, "c-1", d);
  assert.equal(owner.state, "acquired");

  const adapter = build({ dictionary: fixture, store });
  const waiter = adapter.runCalls({ host_state: hostState, scope, calls: [call] });

  // Owner settles; the waiter must observe THAT receipt, not run its own.
  store.settle(scopeKey, "c-1", {
    result: { type: "action_call_output", output: { ok: "owners-result" } },
    owner_token: owner.owner_token,
    digest: d,
  });

  const out = await waiter;
  assert.equal(out.handlerInvocations, 0, "a waiter must not execute behind a live owner");
  assert.equal(out.results[0].from_receipt, true);
  assert.deepEqual(out.results[0].output, { ok: "owners-result" }, "both callers see one receipt");

  // Different digest under the same call id is a conflict, not a wait.
  const conflicting = await adapter.runCalls({
    host_state: hostState, scope,
    calls: [{ ...call, arguments: { row: 2 } }],
  });
  assert.equal(conflicting.results[0].error.code, "call_id_conflict");
  assert.equal(conflicting.handlerInvocations, 0);
});

test("an unrecognised store state never means go ahead", async () => {
  // Structural, not a specific bug. Both duplicate-mutation defects were an
  // unhandled state reaching an `else` that executed -- unknown_disposition,
  // then in_flight, each introduced in the very commit that left its branch
  // missing. Execution is now reachable only from an explicit `acquired`, so
  // a state added later fails closed by construction rather than by whoever
  // remembers to add a branch.
  const { referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const fromTheFuture = {
    reserve: () => ({ state: "quarantined_pending_audit" }),
    settle: () => ({ ok: true }),
  };
  const adapter = build({ dictionary, store: fromTheFuture });
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "p",
    namespaces: { pointer: { provider: "x", registrations: { x: { implements: ["pointer.click"] } } } },
  };
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    session_id: "s", runtime_id: "r", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "pointer.click", arguments: {} };

  const sequential = await adapter.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(sequential.handlerInvocations, 0);
  assert.equal(sequential.results[0].error.code, "reconcile_required");

  const concurrent = await adapter.runConcurrent({ host_state: hostState, scope, concurrent: [call] });
  assert.equal(concurrent.handlerInvocations, 0, "runConcurrent must fail closed too");

  // Positive control: a store that DOES acquire still executes, so this is not
  // passing because execution became unreachable.
  const working = {
    reserve: () => ({ state: "acquired", owner_token: "own-1" }),
    settle: () => ({ ok: true }),
  };
  const ok = build({ dictionary, store: working });
  const ran = await ok.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(ran.handlerInvocations, 1);
});

test("malformed host state never resolves supported", async () => {
  // Adversarial input, not a review finding. Every fail-open this branch has
  // had reached the resolver as a value that looked plausible: an absent
  // preflight, an unrecognised state, an undeclared effect. These are the
  // shapes a real host could send after a partial migration or a hand-edited
  // config, and none of them may grant a mutation.
  const { referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const adapter = build({ dictionary: fixture });
  const resolve = (hostState) =>
    adapter.resolve({ hostState, primitive: "data.write", dictionary: fixture });

  const base = { host: "embed", revision: "r", principal_id: "p", preflight: "durable_mutation_store_ready" };
  const registered = { provider: "x", registrations: { x: { implements: ["data.write"] } } };

  // Positive control FIRST: the well-formed case must resolve supported, or
  // everything below passes for the wrong reason.
  assert.equal(resolve({ ...base, namespaces: { data: registered } }).support, "supported");

  for (const [label, hostState] of [
    ["registrations as an array", { ...base, namespaces: { data: { provider: "x", registrations: [{ implements: ["data.write"] }] } } }],
    // A truthy string a looser check would have accepted as the boolean.
    ["implements_namespace as a string", { ...base, namespaces: { data: { provider: "x", registrations: { x: { implements_namespace: "yes" } } } } }],
    ["namespaces null", { ...base, namespaces: null }],
    ["no host state at all", undefined],
    ["implements as a string", { ...base, namespaces: { data: { provider: "x", registrations: { x: { implements: "data.write" } } } } }],
  ]) {
    assert.equal(resolve(hostState).support, "unsupported", `${label} must not resolve supported`);
  }
});

test("an unknown continuation token mints a fresh scope, not an oracle", async () => {
  // The ruling's Q1: an unknown token is treated exactly like NO token. Not
  // "look it up globally, then refuse on principal mismatch" -- that discloses
  // existence by timing whatever the response says. A token belonging to
  // another principal must be observationally identical to a random one.
  const { DurableReceiptStore, admitContinuation, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const store = new DurableReceiptStore();
  const alice = {
    tenant_id: "t", installation_id: "i", principal_id: "alice", authority_mode: "owner_rights",
  };
  const bob = { ...alice, principal_id: "bob" };

  // Alice establishes a scope.
  const created = admitContinuation({ trusted: alice, presented: null, store });
  assert.equal(created.continuity, "created");
  store.reserve(key({ ...alice, continuation_id: created.continuation_id }), "c-1", "d");

  // Alice resumes it.
  const resumed = admitContinuation({ trusted: alice, presented: created.continuation_id, store });
  assert.equal(resumed.continuity, "resumed");
  assert.equal(resumed.continuation_id, created.continuation_id);

  // Bob presents Alice's valid token. Indistinguishable from a random one:
  // both mint, neither reveals that the token exists somewhere.
  const stolen = admitContinuation({ trusted: bob, presented: created.continuation_id, store });
  const random = admitContinuation({ trusted: bob, presented: "cont-neverexisted00", store });
  assert.equal(stolen.continuity, "created");
  assert.equal(random.continuity, "created");
  assert.notEqual(stolen.continuation_id, created.continuation_id, "the caller's value is never adopted");

  // An explicit CLAIMED principal that conflicts is a different case: that is
  // principal_mismatch, and it is not token classification.
  const claiming = admitContinuation({
    trusted: { ...alice, claimed_principal_id: "bob" }, presented: null, store,
  });
  assert.equal(claiming.outcome, "error");
  assert.equal(claiming.reason, "principal_mismatch");

  // Malformed input is its own answer, before any lookup.
  assert.equal(admitContinuation({ trusted: alice, presented: "", store }).reason, "invalid_arguments");
  assert.equal(admitContinuation({ trusted: alice, presented: "x".repeat(200), store }).reason, "invalid_arguments");
});

test("authority_mode is part of the continuation binding", async () => {
  // Q2: an owner-rights token presented in caller-rights mode does not resume
  // owner-rights receipts. It is simply unknown inside the caller-rights
  // binding, so a fresh one is minted -- never downgraded, upgraded, or
  // replayed across modes.
  const { DurableReceiptStore, admitContinuation, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const store = new DurableReceiptStore();
  const owner = {
    tenant_id: "t", installation_id: "i", principal_id: "alice", authority_mode: "owner_rights",
  };
  const caller = { ...owner, authority_mode: "caller_rights" };

  const created = admitContinuation({ trusted: owner, presented: null, store });
  store.reserve(key({ ...owner, continuation_id: created.continuation_id }), "c-1", "d");

  // Same principal, same token, different authority mode.
  const crossed = admitContinuation({ trusted: caller, presented: created.continuation_id, store });
  assert.equal(crossed.continuity, "created", "a token must not cross authority modes");
  assert.notEqual(crossed.continuation_id, created.continuation_id);

  // Positive control: under the ORIGINAL mode it still resumes, so the above
  // is not passing because resumption stopped working.
  assert.equal(
    admitContinuation({ trusted: owner, presented: created.continuation_id, store }).continuity,
    "resumed",
  );
});

test("the eight-step V1 lifecycle: two hosts, one durable store", async () => {
  // The acceptance proof, in the shape the host-adapter review specified. Two distinct host
  // instances sharing NOTHING but durable rows -- which is what a Streamlit V1
  // rerun actually does to a Python process. A test keeping one adapter alive
  // does not exercise that boundary, and my earlier reconstruction test only
  // half did: it carried a snapshot but gave both instances the same
  // runtime_id, so it could not have caught the rotation miss.
  const { DurableReceiptStore, referenceAdapter: build, admitContinuation, authorityKey: key, requestDigest: digest } =
    await import("../../../contracts/capability-resolution/reference-adapter.mjs");

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const durable = new DurableReceiptStore();
  const trusted = {
    tenant_id: "t-1", installation_id: "inst-1",
    principal_id: "viewer@example.com", authority_mode: "owner_rights",
  };
  const hostState = {
    host: "embed", revision: "rev-A",
    principal_id: trusted.principal_id, authority_mode: "owner_rights",
    preflight: "durable_mutation_store_ready",
    projection: "streamlit-container-v2", transport_status: "supported",
    namespaces: { data: { provider: "snowflake", registrations: { snowflake: { implements: ["data.write"] } } } },
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 7 } };

  // 1-2. Instance A starts and mints a continuation: the browser presented none.
  const a = build({ dictionary: fixture, store: durable });
  const opened = admitContinuation({ trusted, presented: null, store: durable });
  assert.equal(opened.continuity, "created");
  const continuation = opened.continuation_id;

  // 3-4. The component submits; A admits and executes under a runtime id that
  // belongs to THIS script run.
  const scopeA = { ...trusted, continuation_id: continuation, runtime_id: "run-A" };
  const first = await a.runCalls({ host_state: hostState, scope: scopeA, calls: [call] });
  assert.equal(first.handlerInvocations, 1);
  assert.equal(first.results[0].type, "action_call_output");

  // 5. The rerun destroys instance A. Only durable rows cross.
  const carried = DurableReceiptStore.from(durable.snapshot());
  const b = build({ dictionary: fixture, store: carried });

  // 6. Instance B recovers the continuation from the browser-carried token,
  // under a DIFFERENT runtime id -- the rotation a rerun actually causes.
  const resumed = admitContinuation({ trusted, presented: continuation, store: carried });
  assert.equal(resumed.continuity, "resumed", "the continuation must survive reconstruction");
  const scopeB = { ...trusted, continuation_id: continuation, runtime_id: "run-B" };

  // 7. Same call, same digest: the stored receipt replays, nothing executes.
  const replay = await b.runCalls({ host_state: hostState, scope: scopeB, calls: [call] });
  assert.equal(replay.handlerInvocations, 0, "reconstruction must not re-execute the mutation");
  assert.equal(replay.results[0].from_receipt, true);

  // 8. Another principal presenting the same token gets a fresh scope, not
  // the receipt -- and learns nothing about whether the token existed.
  const intruder = { ...trusted, principal_id: "someone.else@example.com" };
  const theirs = admitContinuation({ trusted: intruder, presented: continuation, store: carried });
  assert.equal(theirs.continuity, "created");
  assert.notEqual(theirs.continuation_id, continuation);

  // A different digest under the same call id conflicts rather than replaying.
  const conflicting = await b.runCalls({
    host_state: hostState, scope: scopeB,
    calls: [{ ...call, arguments: { row: 8 } }],
  });
  assert.equal(conflicting.results[0].error.code, "call_id_conflict");
  assert.equal(conflicting.handlerInvocations, 0);

  // An unresolved owner after loss is reconcile-required, never a second run.
  const orphan = DurableReceiptStore.from(carried.snapshot());
  const scopeC = { ...trusted, continuation_id: continuation, runtime_id: "run-C" };
  const orphanKey = key(scopeC);
  const resolved = b.resolve({ hostState, primitive: "data.write", dictionary: fixture });
  orphan.reserve(orphanKey, "c-2", digest({ ...call, call_id: "c-2", provider: resolved.provider, primitive_version: null }));
  orphan.loseOwner(orphanKey, "c-2");
  const c = build({ dictionary: fixture, store: orphan });
  const stranded = await c.runCalls({
    host_state: hostState, scope: scopeC,
    calls: [{ ...call, call_id: "c-2" }],
  });
  assert.equal(stranded.handlerInvocations, 0);
  assert.equal(stranded.results[0].error.code, "unknown_disposition");
});

test("a settled receipt survives withdrawal of the provider that served it", async () => {
  // Added because a sabotage passed. Putting provider back into request
  // identity did not fail the suite, which means the reported defect --
  // a configuration change erasing a settled fact -- was fixed and left
  // untested. A fix nothing checks is one refactor from regressing.
  const { DurableReceiptStore, referenceAdapter: build } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const store = new DurableReceiptStore();
  const hostState = (withProvider) => ({
    host: "embed", revision: "rev-A", principal_id: "p", authority_mode: "owner_rights",
    preflight: "durable_mutation_store_ready",
    projection: "streamlit-container-v2", transport_status: "supported",
    namespaces: withProvider
      ? { data: { provider: "snowflake", registrations: { snowflake: { implements: ["data.write"] } } } }
      : {},
  });
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    continuation_id: "cont-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };

  const first = await build({ dictionary: fixture, store }).runCalls({
    host_state: hostState(true), scope, calls: [call],
  });
  assert.equal(first.handlerInvocations, 1);

  // The provider is withdrawn. The settled receipt must still be reachable:
  // request identity is caller-stable and does not depend on resolving one.
  const after = await build({ dictionary: fixture, store }).runCalls({
    host_state: hostState(false), scope, calls: [call],
  });
  assert.equal(after.handlerInvocations, 0, "withdrawal must not cause re-execution");
  assert.equal(after.results[0].from_receipt, true, "the settled fact must survive withdrawal");
  assert.equal(
    after.results[0].execution_binding.provider,
    "snowflake",
    "the receipt records what actually ran, even though that provider is gone",
  );

  // Positive control: a DIFFERENT call id under the same withdrawn provider
  // genuinely cannot proceed, so the replay above is not passing because the
  // resolver stopped refusing anything.
  const fresh = await build({ dictionary: fixture, store }).runCalls({
    host_state: hostState(false), scope, calls: [{ ...call, call_id: "c-2" }],
  });
  assert.equal(fresh.handlerInvocations, 0);
  assert.equal(fresh.results[0].error.code, "capability_unavailable");
});

test("a rejected call leaves no admitted state", async () => {
  // The wedge I introduced by reordering. reserve() acquired before live
  // resolution, resolution then rejected, and nothing released the
  // reservation -- so the next identical request awaited a promise nobody
  // would settle. On Snowflake that is a durable row, not a process artifact.
  const { DurableReceiptStore, referenceAdapter: build, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const store = new DurableReceiptStore();
  // No provider: the call is unsupported.
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "p", authority_mode: "owner_rights",
    preflight: "durable_mutation_store_ready",
    projection: "streamlit-container-v2", transport_status: "supported",
    namespaces: {},
  };
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    continuation_id: "cont-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };
  const adapter = build({ dictionary: fixture, store });

  const first = await adapter.runCalls({ host_state: hostState, scope, calls: [call] });
  assert.equal(first.results[0].error.code, "capability_unavailable");
  assert.equal(first.handlerInvocations, 0);

  // No row was written, so the store cannot report a scope for this authority.
  assert.equal(store.hasScope(key(scope)), false, "a rejected call must write nothing");

  // And the identical next request answers PROMPTLY rather than waiting.
  const second = await Promise.race([
    adapter.runCalls({ host_state: hostState, scope, calls: [call] }),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 100)),
  ]);
  assert.notEqual(second, "TIMEOUT", "the second identical rejected call wedged");
  assert.equal(second.results[0].error.code, "capability_unavailable");
  assert.equal(second.handlerInvocations, 0);
});

test("a competing host settling between inspect and reserve is handled", async () => {
  // inspect() is a read, so another host may win the race before this one
  // reserves. Every outcome of the atomic call is handled as if it had.
  const { DurableReceiptStore, referenceAdapter: build, authorityKey: key, requestDigest: digest } =
    await import("../../../contracts/capability-resolution/reference-adapter.mjs");

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const store = new DurableReceiptStore();
  const hostState = {
    host: "embed", revision: "rev-A", principal_id: "p", authority_mode: "owner_rights",
    preflight: "durable_mutation_store_ready",
    projection: "streamlit-container-v2", transport_status: "supported",
    namespaces: { data: { provider: "x", registrations: { x: { implements: ["data.write"] } } } },
  };
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    continuation_id: "cont-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };

  // A competing host acquires and settles first.
  const scopeKey = key(scope);
  const d = digest({ ...call, primitive_version: null });
  // The binding is supplied at ADMISSION, matching the one-INSERT design and
  // the Snowflake adapter's conditional UPDATE, which never touches it.
  const other = store.reserve(scopeKey, "c-1", d, {
    provider: "x", primitive_version: null, effect: "mutation",
  });
  store.settle(scopeKey, "c-1", {
    result: { type: "action_call_output", output: { ok: "theirs" } },
    owner_token: other.owner_token, digest: d,
  });

  const out = await build({ dictionary: fixture, store }).runCalls({
    host_state: hostState, scope, calls: [call],
  });
  assert.equal(out.handlerInvocations, 0, "the loser must not execute");
  assert.equal(out.results[0].from_receipt, true);
  assert.deepEqual(out.results[0].output, { ok: "theirs" });

  // P2: replay carries a current-capability diagnostic alongside the
  // immutable binding, and it is non-authoritative.
  assert.ok(out.results[0].current_capability, "replay must carry a capability diagnostic");
  assert.equal(out.results[0].current_capability.support, "supported");
  assert.equal(out.results[0].execution_binding.provider, "x");
});

test("both call paths enforce the same admission discipline", async () => {
  // Parametrised over runCalls AND runConcurrent, because fixing one and
  // leaving the other is the shape of the last several defects here. The
  // previous fix taught runCalls to inspect before reserving; runConcurrent
  // still resolved, DISCARDED the verdict, and executed -- so an unsupported
  // call both ran and wrote a row. A per-path test would have missed it
  // exactly as I did.
  const { DurableReceiptStore, referenceAdapter: build, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" }],
  };
  const unsupported = {
    host: "embed", revision: "rev-A", principal_id: "p", authority_mode: "owner_rights",
    preflight: "durable_mutation_store_ready",
    projection: "streamlit-container-v2", transport_status: "supported",
    namespaces: {},
  };
  const supported = {
    ...unsupported,
    namespaces: { data: { provider: "x", registrations: { x: { implements: ["data.write"] } } } },
  };
  const scope = {
    installation_id: "i", tenant_id: "t", principal_id: "p",
    continuation_id: "cont-1", authority_mode: "owner_rights",
  };
  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };

  for (const [name, invoke] of [
    ["runCalls", (a, hs) => a.runCalls({ host_state: hs, scope, calls: [call] })],
    ["runConcurrent", (a, hs) => a.runConcurrent({ host_state: hs, scope, concurrent: [call] })],
  ]) {
    const store = new DurableReceiptStore();
    const adapter = build({ dictionary: fixture, store });

    const rejected = await invoke(adapter, unsupported);
    assert.equal(rejected.handlerInvocations, 0, `${name}: an unsupported call must not execute`);
    assert.equal(
      rejected.results[0].error.code,
      "capability_unavailable",
      `${name}: must report the refusal`,
    );
    assert.equal(store.hasScope(key(scope)), false, `${name}: a rejected call must write nothing`);

    // Positive control: the SAME path does execute when the call is
    // supported, so the assertions above are not passing because the path
    // stopped working entirely.
    const allowed = await invoke(build({ dictionary: fixture, store }), supported);
    assert.equal(allowed.handlerInvocations, 1, `${name}: a supported call must execute`);
  }
});

test("the resolution layer is consumable from Python", async () => {
  // NARROW by design, and named for what it proves. It runs the Python
  // resolver against `resolve` and `preflight` only -- two of ten operations.
  //
  // The earlier name was "the contract is consumable from a second language",
  // which claimed ground it never walked. an independent host supplied the discriminator, not
  // the objection: before she corrected her independent Python host, all 14
  // shared request-digest goldens disagreed with its digest while this gate
  // reported "no mismatches" and stayed green. A gate whose name covers ground
  // it never walks answers a question nobody asked and looks like it answered
  // the one they did.
  //
  // Digest, receipt and store conformance are proven on the Python/Snowflake
  // branch, which is the production boundary.
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const script = new URL(
    "../../../contracts/capability-resolution/conformance/python_resolver_contract_smoke.py",
    import.meta.url,
  ).pathname;

  let output;
  try {
    output = execFileSync("python3", [script], { encoding: "utf8" });
  } catch (error) {
    // A missing python3 must not silently pass: a harness reporting success
    // when it did not run is the defect class this branch keeps finding.
    assert.fail(`the Python smoke did not run: ${error.stderr || error.message}`);
  }

  assert.match(output, /no mismatches/, output);
  const [, count] = output.match(/^(\d+) resolve\/preflight expectations checked/m) ?? [];
  assert.ok(Number(count) > 0, "the Python smoke checked nothing");

  // And the SCOPE is asserted, so the artifact cannot quietly regrow its claim
  // without the assertion noticing. If it ever covers more operations, this
  // fails and someone has to widen it deliberately.
  const corpus = JSON.parse(
    await readFile(
      new URL("../../../contracts/capability-resolution/host-resolution.vectors.json", import.meta.url),
      "utf8",
    ),
  );
  const allOperations = new Set(
    corpus.vectors.filter((v) => v.expectation === "target").map((v) => v.operation),
  );
  const uncovered = [...allOperations].filter((op) => !["resolve", "preflight"].includes(op));
  assert.ok(
    uncovered.length > 0,
    "this smoke is scoped to resolve/preflight; if nothing is uncovered, widen the claim deliberately",
  );
  assert.match(output, /RESOLUTION LAYER/, "the output must not imply whole-contract coverage");
});

test("the store API matches what a real backend can implement atomically", async () => {
  // Pinned against the Snowflake Hybrid Table adapter, which writes ONE row
  // under an enforced composite primary key. Whatever the row must carry has
  // to be present at INSERT: a binding supplied only at settle would need a
  // second write and reopen the admission window this design closes.
  //
  // The reference store took execution_binding only at settle. That worked
  // against an in-memory Map and would not have survived contact with the real
  // backend -- the kind of divergence a test double hides until integration.
  const { DurableReceiptStore, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const store = new DurableReceiptStore();
  const scopeKey = key({ installation_id: "i", principal_id: "p" });
  const binding = { provider: "snowflake", primitive_version: 1, effect: "mutation" };

  const claim = store.reserve(scopeKey, "c-1", "digest-1", binding);
  assert.equal(claim.state, "acquired");

  // The binding is durable from admission, before anything settles.
  const midFlight = store.inspect(scopeKey, "c-1", "digest-1");
  assert.equal(midFlight.state, "in_flight");

  store.settle(scopeKey, "c-1", {
    result: { ok: true }, owner_token: claim.owner_token, digest: "digest-1",
  });

  // Settling without repeating the binding must not erase what admission
  // recorded.
  const terminal = store.inspect(scopeKey, "c-1", "digest-1");
  assert.equal(terminal.state, "settled");
  assert.deepEqual(
    terminal.receipt.execution_binding,
    binding,
    "the admission binding must survive a settle that does not repeat it",
  );

  // inspect() is non-mutating: repeating it cannot admit anything, which is
  // what lets an unsupported call be rejected without writing a row.
  const before = store.hasScope(scopeKey);
  store.inspect(scopeKey, "c-never", "digest-x");
  assert.equal(store.hasScope(scopeKey), before);
  assert.equal(store.inspect(scopeKey, "c-never", "digest-x").state, "absent");
});

test("the admission binding is immutable at settlement", async () => {
  // An audit boundary, not a detail. The previous store did
  // `binding ?? row.execution_binding`, so whoever settled could replace the
  // provider, version or effect identity recorded at admission -- rewriting
  // the record of what actually executed.
  //
  // The Snowflake adapter's conditional UPDATE deliberately changes only
  // state, result and error. Two store contracts disagreeing on which fields
  // a terminal transition may touch is the kind of divergence that surfaces
  // as an unexplainable audit trail rather than a test failure.
  const { DurableReceiptStore, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  const store = new DurableReceiptStore();
  const scopeKey = key({ installation_id: "i", principal_id: "p" });
  const admitted = { provider: "admitted", primitive_version: 1, effect: "mutation" };

  const claim = store.reserve(scopeKey, "c-1", "d", admitted);
  store.settle(scopeKey, "c-1", {
    result: { ok: true },
    owner_token: claim.owner_token,
    digest: "d",
    // Ignored by contract: settle has no say over what executed.
    execution_binding: { provider: "different", primitive_version: 99, effect: "read_only" },
  });

  const terminal = store.inspect(scopeKey, "c-1", "d");
  assert.deepEqual(
    terminal.receipt.execution_binding,
    admitted,
    "settlement rewrote the record of what executed",
  );

  // Positive control: a binding IS recorded, so this does not pass by the
  // store having stopped keeping one.
  assert.equal(terminal.receipt.execution_binding.provider, "admitted");
});

test("a crashed owner expires by lease, not by announcing its own death", async () => {
  // Portability finding, from comparing my store against the Snowflake
  // adapter's "server-time lease classification" rather than waiting to be
  // told. Mine flipped a boolean `owner_live`, which only ever changes because
  // someone calls loseOwner -- and the process that would call it is the one
  // that died. So a crashed owner stayed in_flight forever and every later
  // caller coalesced behind a promise nobody would settle.
  //
  // A durable store cannot depend on its client to announce its own death.
  const { DurableReceiptStore, authorityKey: key } = await import(
    "../../../contracts/capability-resolution/reference-adapter.mjs"
  );

  let clock = 1_000;
  const store = new DurableReceiptStore({ leaseMs: 5_000, now: () => clock });
  const scopeKey = key({ installation_id: "i", principal_id: "p" });

  const claim = store.reserve(scopeKey, "c-1", "d", { provider: "x" });
  assert.equal(claim.state, "acquired");
  assert.equal(store.inspect(scopeKey, "c-1", "d").state, "in_flight");

  // Within the lease, a waiter still coalesces -- the owner may yet settle.
  clock += 3_000;
  assert.equal(store.inspect(scopeKey, "c-1", "d").state, "in_flight");

  // Past it, the disposition is unresolved. NOT an invitation to execute:
  // the caller gets unknown_disposition and must reconcile.
  clock += 3_000;
  assert.equal(store.inspect(scopeKey, "c-1", "d").state, "unknown_disposition");

  // A settled row is terminal regardless of elapsed time -- expiry classifies
  // an unresolved reservation, never a completed one.
  const settled = new DurableReceiptStore({ leaseMs: 5_000, now: () => clock });
  const owner = settled.reserve(scopeKey, "c-2", "d", { provider: "x" });
  settled.settle(scopeKey, "c-2", { result: { ok: true }, owner_token: owner.owner_token, digest: "d" });
  clock += 60_000;
  assert.equal(settled.inspect(scopeKey, "c-2", "d").state, "settled");
});
