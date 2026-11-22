// Conformance: the JS implementation executed against the shared corpus.
//
// Every other test in this suite was written alongside the code it checks. That
// proves internal consistency and nothing about conformance -- a corpus and a
// test suite written by the same hand agree by construction. This file runs the
// corpus itself, through the same adapter interface a Rust harness would use.
//
// The runner treats an unconsumed expectation field as a failure, so a vector
// cannot pass because the runner quietly ignored half of what it asserts.

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { runCorpus, dispatchableOperations } from "../../../contracts/capability-resolution/runner.mjs";
import {
  CapabilityContractError,
  assertCanonicalDocument,
  assertResolvedCatalogForHost,
  parseLegacyPackagedDictionary,
  providerIsOpaque,
  redactSnapshot,
  resolveCapability,
  resolveCatalog,
  validateHostDescriptor,
} from "../src/primitives/capability-resolver.mjs";
import { EmbedHost, PrimitiveRegistry, ReceiptLedger } from "../src/embed/embed-host.mjs";

const corpusPath = new URL("../../../contracts/capability-resolution/host-resolution.vectors.json", import.meta.url);
const dictionaryPath = new URL("../src/primitives/dictionary.v1.json", import.meta.url);

const dictionary = JSON.parse(await readFile(dictionaryPath, "utf8"));

/**
 * The JS side of the shared adapter interface. A Rust harness implements the
 * same four entry points over the same corpus; neither side gets a private
 * reading of a vector.
 */
const jsAdapter = {
  resolve({ hostState, primitive, callContext, dictionary: inline }) {
    // A vector that names no primitive is asking about the dictionary as a
    // whole; the runner handles that shape, not this adapter.
    if (!primitive) throw new Error("vector supplies no primitive to resolve");
    // A vector may carry its own dictionary when it exercises a namespace the
    // canonical one does not yet define -- `data.*` is proposed by #335 and
    // not shipped, and rewriting those vectors to existing primitives would
    // stop them testing what they are for.
    return resolveCapability({ dictionary: inline ?? dictionary, hostState, primitive, callContext });
  },

  catalog({ hostState, callContext, dictionary: inline }) {
    // `resolve` honoured an inline dictionary and this did not, so a catalog
    // vector carrying its own dictionary was silently resolved against the
    // shipped one -- passing or failing for a reason unrelated to the vector.
    return resolveCatalog({ dictionary: inline ?? dictionary, hostState, callContext });
  },

  validateHostDescriptor(descriptor) {
    return validateHostDescriptor(descriptor);
  },

  redact(snapshot) {
    return redactSnapshot(snapshot);
  },

  providerIsOpaque(snapshot) {
    return providerIsOpaque(snapshot);
  },

  parse(input) {
    try {
      if (input.document_inline?.kind === "canonical" || input.document_inline?.adapters) {
        assertCanonicalDocument(input.document_inline);
      } else if (input.document_inline) {
        // A document with no declared host is the legacy path; the parser is
        // the only thing that reads that shape.
        parseLegacyPackagedDictionary(input.document_inline, { expectedHost: input.expected_host });
      }
      return { outcome: "ok", reason: null };
    } catch (error) {
      return {
        outcome: "error",
        reason: error instanceof CapabilityContractError ? error.reason : "invalid_document",
      };
    }
  },

  formatCatalog(input) {
    try {
      assertResolvedCatalogForHost(input.resolved_catalog, input.format_as_host);
      return { outcome: "ok", reason: null };
    } catch (error) {
      return { outcome: "error", reason: error.reason };
    }
  },

  runCalls(input) {
    const { host, registry, ledger, invocations } = buildHost(input.host_state);
    const results = [];
    const mutations = input.mutations ?? [];

    return (async () => {
      for (const [index, call] of (input.calls ?? []).entries()) {
        const scope = call.scope ?? input.scope ?? {};
        const before = invocations.count;
        const item = await host.withScope(scope).handleActionCall(call);
        results.push({ ...item, executed: invocations.count > before });

        for (const mutation of mutations.filter((m) => m.after_call === index)) {
          if (mutation.withdraw_namespace) delete input.host_state.namespaces[mutation.withdraw_namespace];
          if (mutation.new_revision) input.host_state.revision = mutation.new_revision;
        }
      }
      return { results, handlerInvocations: invocations.count };
    })();
  },

  runConcurrent(input) {
    const { host, invocations } = buildHost(input.host_state);
    const scope = input.scope ?? {};
    return (async () => {
      const results = await Promise.all(
        (input.concurrent ?? []).map((call) => host.withScope(scope).handleActionCall(call)),
      );
      return { results, handlerInvocations: invocations.count };
    })();
  },
};

function buildHost(hostState) {
  const invocations = { count: 0 };
  const registry = new PrimitiveRegistry();
  for (const primitive of dictionary.primitives) {
    registry.register(primitive.name, async () => {
      invocations.count += 1;
      return { ok: true };
    });
  }
  const ledger = new ReceiptLedger();
  const host = new EmbedHost({
    dictionary,
    hostState,
    registry,
    ledger,
    send: async () => {},
  });
  return { host, registry, ledger, invocations };
}

test("the runner dispatches the operations the corpus declares", async () => {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const declared = new Set(corpus.vectors.filter((v) => v.expectation === "target").map((v) => v.operation));
  const dispatchable = new Set(dispatchableOperations());

  const undispatchable = [...declared].filter((operation) => !dispatchable.has(operation));

  // Reported rather than asserted empty: some operations (cross_projection
  // parity, redaction, host descriptor validation) need host surfaces that do
  // not exist yet, and hiding that behind a passing test is the failure this
  // whole track has been about.
  if (undispatchable.length > 0) {
    console.log(`operations not yet dispatchable: ${undispatchable.join(", ")}`);
  }
  assert.ok(dispatchable.size >= 5, "the runner must dispatch a meaningful share of the corpus");
});

test("the JS implementation conforms to every dispatchable target vector", async () => {
  // A FRESH mutable half per dispatch. One shared adapter let an earlier
  // vector's reservation survive into a later one, so a vector that should
  // have coalesced found its call id already terminal -- failing on a
  // comparison while the adapter was correct in isolation. Cross-vector state
  // is the corpus equivalent of a test that only passes in file order, and I
  // fixed exactly this in the contract gate without carrying it here.
  const isolated = new Proxy(jsAdapter, {
    get(target, property) {
      if (property === "runCalls" || property === "runConcurrent") {
        return (input) => target[property](input);
      }
      return target[property];
    },
  });
  const report = await runCorpus({ corpusPath, adapter: isolated });

  const detail = report.failed
    .map((entry) => {
      const checks = (entry.checks ?? [])
        .map((c) => `${c.check}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
        .join("; ");
      return `${entry.id}: ${entry.error ?? ""} ${checks}`.trim();
    })
    .join("\n  ");

  assert.deepEqual(report.failed, [], `conformance failures:\n  ${detail}`);
  assert.ok(report.passed.length > 0, "the runner must actually execute vectors");
});

test("a wrong answer fails on the check, not on the guard", async () => {
  // Kept, but named for what it proves. This adapter answers WRONG, so the
  // vector fails on mismatched `support` and `reason` -- it never reaches the
  // unconsumed-expectation guard. Verified: report.failed carries failing
  // checks and no UnconsumedAssertion. The guard needs its own test, below.
  const report = await runCorpus({
    corpusPath,
    adapter: { ...jsAdapter, resolve: () => ({ support: undefined, reason: undefined }) },
    only: ["unknown-host-fails-closed"],
  });

  assert.equal(report.passed.length, 0, "a vector must not pass when its expectations are unmet");
  assert.ok(
    report.failed.some((entry) => (entry.checks ?? []).some((check) => !check.ok)),
    "this vector should fail on its checks",
  );
});

test("an unconsumed expectation field fails rather than passing quietly", async (t) => {
  // The guard that makes the runner a contract rather than a checklist: a
  // vector whose expectation the runner cannot check must FAIL, not pass
  // having quietly skipped it. Otherwise an expectation nobody dispatches and
  // an expectation that holds produce identical output.
  //
  // The previous version of this test used an adapter that answered wrong,
  // which fails on a mismatched check and never exercises this machinery at
  // all. Reaching the guard needs an expectation field no operation reads.
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const donor = corpus.vectors.find((v) => v.id === "unknown-host-fails-closed");
  assert.ok(donor, "donor vector missing from the corpus");

  const withOrphanField = {
    ...corpus,
    vectors: [
      {
        ...donor,
        id: "synthetic-unconsumed-expectation",
        expect: { ...donor.expect, no_operation_reads_this: "and that must fail" },
      },
    ],
  };

  const scratch = new URL(`./synthetic-corpus-${process.pid}.json`, import.meta.url);
  await writeFile(scratch, JSON.stringify(withOrphanField), "utf8");
  t.after(() => rm(scratch, { force: true }));

  const report = await runCorpus({ corpusPath: scratch, adapter: jsAdapter });

  assert.equal(report.passed.length, 0, "a vector with an unread expectation must not pass");
  assert.equal(report.failed.length, 1);
  assert.match(
    report.failed[0].error ?? "",
    /not consumed by the runner: no_operation_reads_this/,
    "the failure must name the unread field, not merely fail",
  );
});

test("the unconsumed guard does not fire on a vector the runner fully reads", async (t) => {
  // Positive control. The test above proves the guard CAN fire; without this
  // one, a guard that fired on every vector would look identical -- and would
  // make the whole corpus unpassable for a reason unrelated to conformance.
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const donor = corpus.vectors.find((v) => v.id === "unknown-host-fails-closed");

  const scratch = new URL(`./control-corpus-${process.pid}.json`, import.meta.url);
  await writeFile(scratch, JSON.stringify({ ...corpus, vectors: [donor] }), "utf8");
  t.after(() => rm(scratch, { force: true }));

  const report = await runCorpus({ corpusPath: scratch, adapter: jsAdapter });
  assert.equal(report.failed.length, 0, `unexpected failure: ${report.failed[0]?.error ?? ""}`);
  assert.equal(report.passed.length, 1);
});
