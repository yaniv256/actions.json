// The operation runner: executes vector cases against an implementation.
//
// A corpus of documents is not a contract until something dispatches it. Until
// now the vectors were validated for shape and read by hand-written tests that
// happened to agree with them -- which proves the tests and the corpus were
// written by the same person, not that an implementation conforms.
//
// Two properties make this a contract rather than a checklist:
//
//   1. The runner is implementation-agnostic. It takes an adapter exposing
//      resolve/catalog/parse/call, so the JS resolver and a future Rust one
//      run the SAME bytes rather than each maintaining a private reading.
//
//   2. **Every assertion field must be consumed.** An expectation the runner
//      does not know how to check is a FAILURE, not a silent skip. That is the
//      difference between a suite that passes because the implementation is
//      right and one that passes because nobody looked -- and it is how prose
//      predicates like `must_not` would otherwise sit in the corpus looking
//      like assertions while asserting nothing.

import { readFile } from "node:fs/promises";
import { canonical } from "./reference-adapter.mjs";

/**
 * Fields that carry documentation rather than an assertion. They are declared
 * here, once, so that "this field is narrative" is a decision recorded in the
 * runner rather than an omission nobody notices.
 */
const NARRATIVE_FIELDS = new Set(["note", "must_not", "description", "remediation_note"]);

export class UnconsumedAssertion extends Error {
  constructor(vectorId, fields) {
    super(`${vectorId}: expectation fields not consumed by the runner: ${fields.join(", ")}`);
    this.name = "UnconsumedAssertion";
    this.vectorId = vectorId;
    this.fields = fields;
  }
}

/**
 * Track which expectation fields a check actually read.
 *
 * A Proxy rather than manual bookkeeping: manual bookkeeping is itself a place
 * to forget a field, and forgetting is the failure mode being guarded.
 */
function trackConsumption(expect) {
  const seen = new Set();
  const proxy = new Proxy(expect, {
    get(target, property) {
      if (typeof property === "string") seen.add(property);
      return target[property];
    },
  });
  return { proxy, seen };
}

function unconsumed(expect, seen) {
  return Object.keys(expect).filter((key) => !seen.has(key) && !NARRATIVE_FIELDS.has(key));
}

const OPERATIONS = {
  resolve(vector, adapter, expect) {
    const input = vector.input ?? {};
    const results = [];
    const hostStates = input.host_state?.host
      ? { [input.host_state.host]: input.host_state }
      : input.host_state ?? {};

    if (expect.probes) {
      for (const probe of expect.probes) {
        for (const [host, state] of Object.entries(hostStates)) {
          if (!(host in probe)) continue;
          const resolved = adapter.resolve({
            hostState: state,
            primitive: probe.primitive,
            callContext: input.call_context,
            dictionary: input.dictionary_inline,
          });
          results.push({
            check: `${probe.primitive}@${host}`,
            actual: resolved.support,
            expected: probe[host],
            ok: resolved.support === probe[host],
          });
        }
      }
      return results;
    }

    const state = input.host_state?.host ? input.host_state : Object.values(hostStates)[0];
    let resolved;
    try {
      resolved = adapter.resolve({
        hostState: state,
        primitive: input.primitive ?? vector.primitive,
        callContext: input.call_context,
        dictionary: input.dictionary_inline,
      });
    } catch (error) {
      if (expect.contract_error === undefined) throw error;
      const actual = error?.reason ?? error?.message;
      return [{
        check: "contract_error",
        actual,
        expected: expect.contract_error,
        ok: actual === expect.contract_error,
      }];
    }
    if (expect.contract_error !== undefined) {
      return [{
        check: "contract_error",
        actual: null,
        expected: expect.contract_error,
        ok: false,
      }];
    }

    for (const field of ["support", "reason", "decided_by", "remediation"]) {
      if (expect[field] === undefined) continue;
      results.push({
        check: field,
        actual: resolved[field],
        expected: expect[field],
        ok: resolved[field] === expect[field],
      });
    }
    if (expect.descriptor !== undefined) {
      const actual = canonical(resolved.descriptor);
      const expected = canonical(expect.descriptor);
      results.push({
        check: "descriptor",
        actual: resolved.descriptor,
        expected: expect.descriptor,
        ok: actual === expected,
      });
    }
    return results;
  },

  async call_sequence(vector, adapter, expect) {
    const input = vector.input ?? {};
    const outcome = await adapter.runCalls(input);
    const results = [];

    if (expect.handler_invocations !== undefined) {
      results.push({
        check: "handler_invocations",
        actual: outcome.handlerInvocations,
        expected: expect.handler_invocations,
        ok: outcome.handlerInvocations === expect.handler_invocations,
      });
    }

    (expect.results ?? []).forEach((wanted, index) => {
      const actual = outcome.results[index] ?? {};
      for (const [field, value] of Object.entries(wanted)) {
        if (NARRATIVE_FIELDS.has(field)) continue;
        const observed =
          field === "error_code"
            ? actual.error?.code
            : field === "reason"
              ? actual.error?.reason
              : field === "executed"
                ? actual.executed
                : actual[field];
        results.push({
          check: `results[${index}].${field}`,
          actual: observed,
          expected: value,
          ok: observed === value,
        });
      }
    });

    return results;
  },

  async concurrent_calls(vector, adapter, expect) {
    const outcome = await adapter.runConcurrent(vector.input ?? {});
    const results = [];
    if (expect.handler_invocations !== undefined) {
      results.push({
        check: "handler_invocations",
        actual: outcome.handlerInvocations,
        expected: expect.handler_invocations,
        ok: outcome.handlerInvocations === expect.handler_invocations,
      });
    }
    if (expect.both_results_equal !== undefined) {
      const [first, second] = outcome.results;
      const equal = JSON.stringify(first) === JSON.stringify(second);
      results.push({
        check: "both_results_equal",
        actual: equal,
        expected: expect.both_results_equal,
        ok: equal === expect.both_results_equal,
      });
    }
    return results;
  },

catalog(vector, adapter, expect) {
    const input = vector.input ?? {};
    const hostStates = input.host_state ?? {};
    const results = [];

    for (const probe of expect.probes ?? []) {
      for (const [host, state] of Object.entries(hostStates)) {
        if (!(host in probe)) continue;
        const resolved = adapter.resolve({
          hostState: state,
          primitive: probe.primitive,
          callContext: input.call_context,
          dictionary: input.dictionary_inline,
        });
        results.push({
          check: `${probe.primitive}@${host}`,
          actual: resolved.support,
          expected: probe[host],
          ok: resolved.support === probe[host],
        });
        // A probe may pin the reason and deciding layer as well as the
        // verdict: two hosts refusing for different reasons is a real
        // difference, and comparing only support would hide it.
        if (probe[`${host}_reason`] !== undefined) {
          results.push({
            check: `${probe.primitive}@${host}.reason`,
            actual: resolved.reason,
            expected: probe[`${host}_reason`],
            ok: resolved.reason === probe[`${host}_reason`],
          });
        }
        if (probe[`${host}_decided_by`] !== undefined) {
          results.push({
            check: `${probe.primitive}@${host}.decided_by`,
            actual: resolved.decided_by,
            expected: probe[`${host}_decided_by`],
            ok: resolved.decided_by === probe[`${host}_decided_by`],
          });
        }
      }
    }

    if (expect.differs_across_hosts !== undefined) {
      const hosts = Object.keys(hostStates);
      const catalogs = hosts.map((host) =>
        JSON.stringify(adapter.catalog({ hostState: hostStates[host] })),
      );
      const differs = new Set(catalogs).size > 1;
      results.push({
        check: "differs_across_hosts",
        actual: differs,
        expected: expect.differs_across_hosts,
        ok: differs === expect.differs_across_hosts,
      });
    }

    return results;
  },

  host_descriptor_validation(vector, adapter, expect) {
    const inputs = Array.isArray(vector.input) ? vector.input : [vector.input];
    const wanted = Array.isArray(expect) ? expect : [expect];
    return inputs.map((descriptor, index) => {
      const outcome = adapter.validateHostDescriptor(descriptor);
      const target = wanted[index] ?? {};
      const ok =
        outcome.outcome === target.outcome &&
        (target.reason === undefined || outcome.reason === target.reason);
      return {
        check: `descriptor[${index}] ${descriptor.projection}/${descriptor.authority_mode}`,
        actual: `${outcome.outcome}${outcome.reason ? `:${outcome.reason}` : ""}`,
        expected: `${target.outcome}${target.reason ? `:${target.reason}` : ""}`,
        ok,
      };
    });
  },

  cross_projection_parity(vector, adapter, expect) {
    const input = vector.input ?? {};
    const results = [];
    const catalogs = (input.projections ?? []).map((projection) =>
      adapter.catalog({
        hostState: { ...input.host_state, projection },
        dictionary: input.dictionary_inline,
      }),
    );

    if (expect.host_identity !== undefined) {
      const identities = new Set(catalogs.map((catalog) => catalog.host));
      results.push({
        check: "host_identity",
        actual: identities.size === 1 ? [...identities][0] : [...identities].join("/"),
        expected: expect.host_identity,
        ok: identities.size === 1 && [...identities][0] === expect.host_identity,
      });
    }

    if (expect.resolved_decisions_identical !== undefined) {
      // Compare the decisions, not just the verdicts: identical support
      // reached through different layers is not the same resolution.
      const decisions = catalogs.map((catalog) =>
        JSON.stringify(catalog.primitives.map((p) => [p.primitive, p.support, p.reason, p.decided_by])),
      );
      const identical = new Set(decisions).size === 1;
      results.push({
        check: "resolved_decisions_identical",
        actual: identical,
        expected: expect.resolved_decisions_identical,
        ok: identical === expect.resolved_decisions_identical,
      });
    }

    if (expect.catalog_fingerprints_identical !== undefined) {
      const prints = new Set(catalogs.map((catalog) => catalog.catalog_fingerprint));
      const identical = prints.size === 1;
      results.push({
        check: "catalog_fingerprints_identical",
        actual: identical,
        expected: expect.catalog_fingerprints_identical,
        ok: identical === expect.catalog_fingerprints_identical,
      });
    }

    // Positive control. "Identical across projections" is satisfied by a
    // resolver that ignores projection AND by one that ignores host state
    // entirely. Changing something that MUST move the catalog separates them:
    // if this still comes back identical, the parity above proved nothing.
    if (expect.differs_when_authority_differs !== undefined) {
      const [first] = input.projections ?? [];
      const baseline = adapter.catalog({
        hostState: { ...input.host_state, projection: first },
        dictionary: input.dictionary_inline,
      });
      const narrowed = adapter.catalog({
        hostState: { ...input.host_state, projection: first, namespaces: {} },
        dictionary: input.dictionary_inline,
      });
      const differs = baseline.catalog_fingerprint !== narrowed.catalog_fingerprint;
      results.push({
        check: "differs_when_authority_differs",
        actual: differs,
        expected: expect.differs_when_authority_differs,
        ok: differs === expect.differs_when_authority_differs,
      });
    }

    if (expect.projection_absent_from !== undefined) {
      // Packaging is deployment metadata. If it reached the authority scope,
      // two projections of one installation would be different authorities.
      const leaked = catalogs.some((catalog) =>
        catalog.primitives.some((p) => JSON.stringify(p.authority ?? {}).includes("projection")),
      );
      results.push({
        check: "projection_absent_from_authority_scope",
        actual: leaked ? "present" : "authority scope",
        expected: expect.projection_absent_from,
        ok: !leaked,
      });
    }

    return results;
  },

  redaction_check(vector, adapter, expect) {
    const redacted = adapter.redact(vector.input?.snapshot ?? {});
    const results = [];

    // Recursive, not a top-level key filter: a forbidden key nested inside
    // provider metadata reaches a browser just as readily as one at the root.
    const keysAtAnyDepth = (node, found = new Set()) => {
      if (Array.isArray(node)) {
        node.forEach((item) => keysAtAnyDepth(item, found));
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          found.add(key);
          keysAtAnyDepth(value, found);
        }
      }
      return found;
    };

    const present = keysAtAnyDepth(redacted);
    for (const forbidden of expect.forbidden_keys_absent_at_any_depth ?? []) {
      results.push({
        check: `forbidden:${forbidden}`,
        actual: present.has(forbidden) ? "present" : "absent",
        expected: "absent",
        ok: !present.has(forbidden),
      });
    }
    // Positive control: a redactor that returned {} would pass every
    // assertion above for the wrong reason.
    for (const permitted of expect.permitted_present ?? []) {
      results.push({
        check: `permitted:${permitted}`,
        actual: present.has(permitted) ? "present" : "absent",
        expected: "present",
        ok: present.has(permitted),
      });
    }
    if (expect.provider_rendered_as !== undefined) {
      const opaque = adapter.providerIsOpaque(redacted);
      results.push({
        check: "provider_rendered_as",
        actual: opaque ? "opaque instance id" : "raw provider identity",
        expected: expect.provider_rendered_as,
        ok: opaque,
      });
    }
    return results;
  },

  preflight(vector, adapter, expect) {
    const inputs = Array.isArray(vector.input) ? vector.input : [vector.input];
    const wanted = Array.isArray(expect) ? expect : [expect];
    const results = [];

    inputs.forEach((input, index) => {
      const resolved = adapter.resolve({
        hostState: input.host_state,
        primitive: input.primitive,
        dictionary: input.dictionary_inline,
      });
      const target = wanted[index] ?? {};
      for (const field of ["support", "reason", "remediation"]) {
        if (target[field] === undefined) continue;
        results.push({
          check: `[${index}].${field}`,
          actual: resolved[field],
          expected: target[field],
          ok: resolved[field] === target[field],
        });
      }
    });
    return results;
  },

  parse_document(vector, adapter, expect) {
    const outcome = adapter.parse(vector.input ?? {});
    const results = [];
    if (expect.outcome !== undefined) {
      results.push({
        check: "outcome",
        actual: outcome.outcome,
        expected: expect.outcome,
        ok: outcome.outcome === expect.outcome,
      });
    }
    if (expect.reason !== undefined) {
      results.push({
        check: "reason",
        actual: outcome.reason,
        expected: expect.reason,
        ok: outcome.reason === expect.reason,
      });
    }
    return results;
  },

  format_catalog(vector, adapter, expect) {
    const outcome = adapter.formatCatalog(vector.input ?? {});
    const results = [];
    for (const field of ["outcome", "reason"]) {
      if (expect[field] === undefined) continue;
      results.push({
        check: field,
        actual: outcome[field],
        expected: expect[field],
        ok: outcome[field] === expect[field],
      });
    }
    return results;
  },
};

/**
 * Run every target vector the runner knows how to dispatch.
 *
 * Vectors whose operation has no handler are reported as `undispatched` rather
 * than skipped silently. A corpus with operations nobody executes looks
 * identical to one that passes, and that gap is the thing this file exists to
 * close -- so the caller decides what to do about it with the list in hand.
 */
export async function runCorpus({ corpusPath, adapter, only = null }) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const report = { passed: [], failed: [], undispatched: [], skipped: [] };

  for (const vector of corpus.vectors) {
    if (only && !only.includes(vector.id)) continue;
    if (vector.expectation !== "target") {
      report.skipped.push({ id: vector.id, why: vector.expectation });
      continue;
    }
    const operation = OPERATIONS[vector.operation];
    if (!operation) {
      report.undispatched.push({ id: vector.id, operation: vector.operation });
      continue;
    }
    if (!vector.expect) {
      report.undispatched.push({ id: vector.id, operation: vector.operation, why: "no expect block" });
      continue;
    }

    const { proxy, seen } = trackConsumption(vector.expect);
    let checks;
    try {
      checks = await operation(vector, adapter, proxy);
    } catch (error) {
      report.failed.push({ id: vector.id, error: error.message, checks: [] });
      continue;
    }

    const left = unconsumed(vector.expect, seen);
    if (left.length > 0) {
      report.failed.push({
        id: vector.id,
        error: new UnconsumedAssertion(vector.id, left).message,
        checks,
      });
      continue;
    }

    const failures = checks.filter((check) => !check.ok);
    if (failures.length > 0) report.failed.push({ id: vector.id, checks: failures });
    else report.passed.push({ id: vector.id, checks: checks.length });
  }

  return report;
}

export const dispatchableOperations = () => Object.keys(OPERATIONS);
