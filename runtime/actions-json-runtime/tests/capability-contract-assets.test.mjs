// The contract assets are only a cross-language contract if they are
// executable. A vector corpus of prose assertions is a design document that
// looks like a test suite -- both implementations can "pass" it while
// disagreeing, which is the exact failure the shared corpus exists to prevent.
//
// These tests check the assets themselves: closed enums stay closed, every
// vector is well formed under the declared schema vocabulary, and the golden
// fingerprints reproduce from their stated preimages under the stated
// algorithm.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { createValidator, loadCorpus, validate } from "../../../contracts/capability-resolution/validate.mjs";

const repoRoot = new URL("../../../", import.meta.url);

const contractsDir = new URL("../../../contracts/capability-resolution/", import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, contractsDir), "utf8"));

test("the Snowflake setup producer emits a schema-conforming HostState", async () => {
  const script = String.raw`
import importlib.util, json, pathlib
root = pathlib.Path.cwd()
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
contracts = root / "contracts" / "capability-resolution"
host_module = load("schema_host", contracts / "streamlit_trusted_host.py")
store_module = load("schema_store", contracts / "snowflake_receipt_store.py")
identity = host_module.TrustedIdentity(tenant_id="t", installation_id="i", principal_id="p", authority_mode="owner_rights")
providers = host_module.ProviderRegistry()
providers.register("snowflake", {"data.query": lambda arguments: arguments}, revision="sha256:" + "1" * 64)
store = store_module.SnowflakeReceiptStore(lambda: None, table="APP.RECEIPTS")
dictionary = {"kind":"canonical","version":1,"stage":1,"primitives":[{"name":"data.query","namespace":"data","effect":"read_only","version":1}]}
states = []
for preflight in (store.setup_required(), store.read_only_ready(), {"state":"durable_mutation_store_ready"}, {"state":"unavailable","reason":"receipt_store_preflight_failed"}):
    host = host_module.StreamlitTrustedHost(dictionary=dictionary, identity=identity, projection="streamlit-warehouse-v1", transport_status="supported", installation_revision="r", preflight=preflight, providers=providers, receipt_store=store)
    states.append(host.host_state)
print(json.dumps(states))
`;
  const states = JSON.parse(execFileSync("python3", ["-c", script], {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
  }));
  const validator = createValidator();
  const schema = await readJson("schemas/host-state.schema.json");
  validator.add(schema);
  assert.equal(states.length, 4);
  for (const state of states) {
    assert.deepEqual(validator.validate(state, schema.$id), []);
  }
  assert.equal(states[3].preflight, "read_only_ready");
  assert.ok(!("reason" in states[3]));

  // Positive control: the public schema must reject drift in the packet the
  // producer emits, rather than passing because the object is unconstrained.
  states[0].setup_packet.extra = "must fail";
  assert.ok(validator.validate(states[0], schema.$id).length > 0);
  for (const state of states.slice(1)) {
    state.setup_packet = { sql: "x", required_privilege: "x", target: "x" };
    assert.ok(validator.validate(state, schema.$id).length > 0);
  }
});

test("the resolution schema closes every vocabulary an implementation must agree on", async () => {
  const schema = await readJson("schemas/resolution.schema.json");
  const defs = schema.$defs;

  // Each of these must be an enum, not a bare string type. A free-text layer
  // or reason cannot be compared across languages.
  for (const name of ["layer", "source", "reason", "remediation", "contract_error"]) {
    assert.ok(Array.isArray(defs[name]?.enum), `${name} must be a closed enum`);
    assert.ok(defs[name].enum.length > 0);
  }

  // provider_health is a SOURCE, not a sixth layer -- the layer vocabulary
  // stays at the normative five.
  assert.deepEqual(defs.layer.enum, [
    "dictionary",
    "provider_registration",
    "host_state",
    "compatibility_override",
    "call_context",
  ]);
  assert.ok(defs.source.enum.includes("provider_health"));
  assert.ok(!defs.layer.enum.includes("provider_health"));

  // Authority binds to principal, not installation alone.
  const authority = defs.authority_scope;
  assert.ok(authority.required.includes("principal_id"));
  assert.ok(authority.required.includes("installation_revision"));
  assert.ok(authority.properties.authority_mode.enum.includes("owner_rights"));
  assert.ok(authority.properties.authority_mode.enum.includes("caller_rights"));

  // Remediation is a field, not something an agent infers from a prose table.
  assert.ok(schema.required.includes("remediation"));
  assert.ok(schema.required.includes("decided_by"));

  // Unknown fields are rejected, so a resolver cannot smuggle host-specific
  // meaning through an undeclared key.
  assert.equal(schema.additionalProperties, false);
  assert.equal(defs.decision.additionalProperties, false);
});

test("every vector is well formed under the declared vocabulary", async () => {
  const vectors = await readJson("host-resolution.vectors.json");
  const schema = await readJson("schemas/resolution.schema.json");

  const layers = new Set(schema.$defs.layer.enum);
  // A vector may name either a resolution reason or a contract error: they are
  // different vocabularies -- one says why a capability is unavailable, the
  // other why a document could not be resolved at all.
  const reasons = new Set([...schema.$defs.reason.enum, ...schema.$defs.contract_error.enum]);
  const remediations = new Set(schema.$defs.remediation.enum);
  const kinds = new Set(["canonical", "resolved_snapshot", "legacy_flat"]);

  assert.equal(vectors.schema, "actions-json/capability-resolution-vectors/v4");
  assert.ok(vectors.schemas.resolution, "the corpus must point at its schema");

  const ids = new Set();
  for (const vector of vectors.vectors) {
    assert.ok(vector.id, "every vector needs an id");
    assert.ok(!ids.has(vector.id), `duplicate vector id ${vector.id}`);
    ids.add(vector.id);
    assert.ok(kinds.has(vector.document_kind), `${vector.id}: unknown document_kind`);
    assert.ok(["current-defect", "target"].includes(vector.expectation));

    if (vector.expectation === "current-defect") {
      assert.ok(vector.expect_after_fix, `${vector.id}: pins a defect without stating the target`);
      assert.ok(vector.observed_today, `${vector.id}: pins a defect without an observation`);
    }

    // Any reason, layer or remediation a vector EXPECTS must exist in the
    // schema. A vector asserting a code no implementation can emit is a test
    // nobody can pass and everybody can claim to.
    //
    // Only the expectation side is checked. Inputs legitimately carry legacy
    // values -- the two-valued migration vector feeds in the bookmarklet's
    // stale `trusted_key_events_unavailable` precisely so validation rejects
    // it, and a corpus that could not express a bad input could not test one.
    const expectations = {
      expect: vector.expect,
      expect_after_fix: vector.expect_after_fix,
      sequence: vector.sequence,
    };

    for (const found of collect(expectations, "reason")) {
      if (found === null) continue;
      assert.ok(reasons.has(found), `${vector.id}: unknown reason "${found}"`);
    }
    for (const found of collect(expectations, "decided_by")) {
      assert.ok(layers.has(found), `${vector.id}: unknown decided_by "${found}"`);
    }
    for (const found of collect(expectations, "trace_must_name_layer")) {
      assert.ok(layers.has(found), `${vector.id}: unknown layer "${found}"`);
    }
    for (const found of collect(expectations, "remediation")) {
      assert.ok(remediations.has(found), `${vector.id}: unknown remediation "${found}"`);
    }
  }
});

test("provider ambiguity fails closed rather than picking a winner", async () => {
  const vectors = await readJson("host-resolution.vectors.json");
  const vector = vectors.vectors.find((entry) => entry.id === "provider-ambiguity-fails-closed");

  assert.ok(vector, "the ambiguity vector must exist");
  assert.equal(vector.expect.support, "unsupported");
  assert.equal(vector.expect.reason, "provider_conflict");

  // The earlier version permitted "either a conflict or a deterministic
  // winner". Determinism is not consent: candidates can be different tenants
  // or credentials, so an implicit winner silently picks an authority.
  assert.ok(!("either" in vector.expect), "ambiguity must not permit an implicit winner");
});

test("no supported target vector expects support without provider registration", async () => {
  const vectors = await readJson("host-resolution.vectors.json");

  for (const vector of vectors.vectors) {
    if (vector.expectation !== "target") continue;
    const expectsSupport = JSON.stringify(vector.expect ?? {}).includes('"supported"');
    if (!expectsSupport) continue;

    const input = JSON.stringify(vector.input ?? vector.sequence ?? {});
    const declaresAuthority =
      input.includes("host_state") ||
      input.includes("provider") ||
      input.includes("namespaces") ||
      input.includes("resolved_for") ||
      vector.id === "decided-by-is-defined-for-supported-resolutions";

    // Support originates at provider registration. A vector expecting support
    // from a bare document restores authority to the dictionary -- which the
    // contract in the same PR forbids.
    assert.ok(
      declaresAuthority,
      `${vector.id}: expects support without supplying provider registration or host state`,
    );
  }
});

test("golden fingerprints reproduce from their stated preimages", async () => {
  const goldens = await readJson("schemas/golden-fingerprints.json");
  assert.ok(goldens.cases.length >= 6);

  const digest = (preimage) =>
    createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 32);

  let checked = 0;
  for (const item of goldens.cases) {
    if (item.kind === "domain_separation") {
      // Identical records under two domains must not collide.
      assert.notEqual(
        item.expected_installation.slice(4),
        item.expected_catalog.slice(4),
        "domain separation must hold",
      );
      continue;
    }
    const prefix = item.kind === "installation_revision" ? "rev-" : "cat-";
    assert.equal(item.expected, prefix + digest(item.preimage), `${item.description}: digest mismatch`);
    checked += 1;
  }
  assert.ok(checked >= 5, "expected several reproducible golden cases");

  // The empty case matters: a resolver returning a constant would pass every
  // non-empty vector.
  assert.ok(goldens.cases.some((item) => item.records.length === 0));
});

test("golden fingerprints distinguish what the spec says they must", async () => {
  const goldens = await readJson("schemas/golden-fingerprints.json");
  const find = (needle) => goldens.cases.find((item) => item.description.includes(needle));

  // Authority mode is part of identity: same providers under owner_rights and
  // caller_rights are different authorities.
  const ownerRights = find("byte-wise sorted");
  const callerRights = find("caller_rights instead of owner_rights");
  assert.ok(ownerRights && callerRights);
  assert.notEqual(ownerRights.expected, callerRights.expected);

  // Two catalogs with identical support that reached it through different
  // layers are not the same catalog -- the same reason the trace exists.
  const byRegistration = find("mixed supported and unsupported");
  const byCallContext = find("different decided_by");
  assert.ok(byRegistration && byCallContext);
  assert.notEqual(byRegistration.expected, byCallContext.expected);
});

// Walk a vector for every occurrence of a key, at any depth.
function collect(node, key, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, found);
    return found;
  }
  if (node && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (name === key && (typeof value === "string" || value === null)) found.push(value);
      else collect(value, key, found);
    }
  }
  return found;
}

test("every document the corpus names resolves and is the declared kind", async () => {
  // The previous asset test validated the corpus's shape and never resolved
  // its references, so both document paths could point outside the repository
  // and the suite stayed green. A validator that does not dereference what it
  // validates proves the document is well formed, not that it refers to
  // anything.
  const { documents } = await loadCorpus({ repoRoot });

  assert.ok(Object.keys(documents).length >= 2);
  for (const [name, entry] of Object.entries(documents)) {
    assert.ok(Array.isArray(entry.value.primitives), `${name}: resolved to no primitives`);
    assert.ok(entry.value.primitives.length > 0, `${name}: resolved to an empty dictionary`);
    assert.equal(entry.kind, entry.descriptor.declared_kind, `${name}: declared kind does not match content`);
  }
});

test("a corpus naming a missing document fails loudly", async () => {
  // Positive control on the guard above: it must fail for a bad path, not
  // merely pass for a good one.
  await assert.rejects(
    () => loadCorpus({ repoRoot: new URL("file:///nonexistent-root-for-this-test/") }),
    /does not resolve/,
  );
});

test("the validator applies every keyword it accepts", () => {
  // The previous hand-rolled validator listed `patternProperties` as supported
  // and never applied it, so a violating document validated clean. The guard
  // asserted its own correctness rather than testing it -- the same failure it
  // existed to prevent, one level up. Ajv 2020 in strict mode replaces it;
  // this is the regression for the exact case that got through.
  const schema = { type: "object", patternProperties: { "^x$": { type: "integer" } } };
  assert.ok(validate({ x: "not-an-integer" }, schema).length > 0, "patternProperties must be applied");
  assert.deepEqual(validate({ x: 3 }, schema), [], "a conforming document must still validate");

  // Strict mode turns an unknown keyword into a compile error rather than a
  // silently permissive validation.
  assert.throws(() => validate({}, { type: "object", nonsenseKeyword: true }));
});

test("the schema rejects a fail-open supported resolution", async () => {
  const schema = await readJson("schemas/resolution.schema.json");

  const failOpen = {
    primitive: "data.query",
    host: "embed",
    support: "supported",
    reason: null,
    remediation: "none",
    decisions: [{ layer: "dictionary", decision: "defined" }],
    decided_by: "provider_registration",
    namespace: "data",
    provider: null,
    authority: { installation_revision: null, principal_id: null },
  };

  // This is the exact shape #338's resolver produced: supported, no provider,
  // no identity. The schema must not accept it.
  assert.ok(validate(failOpen, schema).length > 0);

  const wellFormed = {
    ...failOpen,
    provider: "example-sql",
    descriptor: {
      summary: "Run a registered query.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      source: "dictionary",
      provider_extensions: {},
    },
    decisions: [
      { layer: "dictionary", decision: "defined" },
      { layer: "provider_registration", decision: "supported", provider: "example-sql" },
    ],
    authority: {
      installation_revision: "rev-A",
      principal_id: "principal-a",
      authority_mode: "owner_rights",
    },
  };
  assert.deepEqual(validate(wellFormed, schema), [], "a well-formed resolution must validate");
});

test("every vector declares an executable operation", async () => {
  const vectors = await readJson("host-resolution.vectors.json");
  const kinds = new Set(vectors.operations.kinds);

  // A vector without an operation is a prose scenario: two implementations can
  // both "pass" it while doing different things.
  const missing = vectors.vectors
    .filter((vector) => vector.expectation === "target" && !vector.operation)
    .map((vector) => vector.id);

  assert.deepEqual(missing, [], `target vectors without an operation discriminator: ${missing.join(", ")}`);

  for (const vector of vectors.vectors) {
    if (!vector.operation) continue;
    assert.ok(kinds.has(vector.operation), `${vector.id}: unknown operation "${vector.operation}"`);
  }
});

test("every boundary schema compiles and the corpus validates against its own", async () => {
  // The corpus was previously checked by walking selected key names. That
  // proves a document mentions the right words, not that it conforms -- two
  // implementations could read the same file differently and both pass.
  const validator = createValidator();
  const dir = new URL("schemas/", contractsDir);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".schema.json"));

  assert.ok(names.length >= 7, `expected the full boundary set, found ${names.length}`);

  for (const name of names) {
    validator.add(JSON.parse(await readFile(new URL(name, dir), "utf8")));
  }

  const corpus = await readJson("host-resolution.vectors.json");
  assert.deepEqual(
    validator.validate(corpus, "https://actions.json/contracts/capability-resolution/vector-corpus.schema.json"),
    [],
  );
});

test("the boundary schemas reject the shapes they exist to reject", async () => {
  const validator = createValidator();
  const dir = new URL("schemas/", contractsDir);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".schema.json"))) {
    validator.add(JSON.parse(await readFile(new URL(name, dir), "utf8")));
  }
  const id = (name) => `https://actions.json/contracts/capability-resolution/${name}`;
  const bad = (value, schema) => assert.ok(validator.validate(value, id(schema)).length > 0);
  const good = (value, schema) => assert.deepEqual(validator.validate(value, id(schema)), []);

  // A canonical document carrying flat support is the shape that makes the
  // two input contracts confusable.
  bad(
    { kind: "canonical", version: 1, stage: 1, primitives: [{ name: "a.b", capability_class: "portable", portable: true, support: "supported" }] },
    "canonical-document.schema.json",
  );
  good(
    { kind: "canonical", version: 1, stage: 1, primitives: [{ name: "a.b", capability_class: "portable", portable: true }] },
    "canonical-document.schema.json",
  );

  // A registration must state its membership. An omitted list previously meant
  // "implements everything", which granted a whole namespace from an empty
  // object.
  bad(
    { host: "embed", revision: "r", namespaces: { data: { provider: "p", registrations: { p: {} } } } },
    "host-state.schema.json",
  );
  good(
    { host: "embed", revision: "r", namespaces: { data: { provider: "p", registrations: { p: { implements: ["data.query"] } } } } },
    "host-state.schema.json",
  );

  // A public error crossing into a browser is bounded, and its code is closed.
  bad(
    { code: "something_ad_hoc", message: "boom", correlation_id: "c-1" },
    "request-receipt.schema.json",
  );
  good(
    { code: "handler_failed", message: "Error: handler raised an error", correlation_id: "c-1" },
    "request-receipt.schema.json",
  );

  // A request must carry its full scope: scope IS the receipt-store key, so a
  // partial one would let a colliding call_id cross a session boundary.
  bad(
    { call_id: "c-1", primitive: "data.query", arguments: {}, scope: { tenant_id: "t" } },
    "request-receipt.schema.json",
  );
});
