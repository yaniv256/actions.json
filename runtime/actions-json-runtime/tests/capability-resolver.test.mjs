// Conformance for the JS resolver against the shared vector corpus.
//
// The corpus is language-neutral by design: the Rust resolver runs against the
// same file. These tests are the JS half of that agreement, not a private
// spec -- if an expectation here is not also in the corpus, it is a test the
// other implementation cannot be held to.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CapabilityContractError,
  LAYER,
  REASON,
  agreementIsVerifiable,
  assertCanonicalDocument,
  assertResolvedCatalogForHost,
  namespaceOf,
  parseLegacyPackagedDictionary,
  fingerprint,
  resolveCapability,
  resolveCatalog,
} from "../src/primitives/capability-resolver.mjs";

const canonicalUrl = new URL("../src/primitives/dictionary.v1.json", import.meta.url);
const packagedUrl = new URL(
  "../../../extensions/chrome-overlay-runtime/actions/overlay.actions.json",
  import.meta.url,
);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

// A host state that activates every namespace the dictionary mentions, with no
// implements-list, i.e. "this provider implements the whole namespace". Used
// where the test is about a layer other than registration.
const openHostState = (dictionary, host) => ({
  host,
  revision: "rev-test",
  namespaces: Object.fromEntries(
    [...new Set(dictionary.primitives.map((p) => namespaceOf(p.name)))].map((ns) => [
      ns,
      { provider: `${ns}-provider`, registrations: { [`${ns}-provider`]: { implements_namespace: true } } },
    ]),
  ),
});

// -- vector: canonical-must-not-carry-flat-support ---------------------------

test("canonical document carrying flat support is rejected", () => {
  assert.throws(
    () =>
      assertCanonicalDocument({
        version: 1,
        stage: 1,
        primitives: [{ name: "pointer.click", support: "supported" }],
      }),
    (error) =>
      error instanceof CapabilityContractError &&
      error.reason === "canonical_document_carries_flat_support",
  );
});

// -- vector: stripping-adapters-must-not-erase-host-identity -----------------

test("flattened document without a declared host fails closed", () => {
  assert.throws(
    () =>
      parseLegacyPackagedDictionary({
        version: 1,
        stage: 1,
        primitives: [{ name: "browser.open_tab", support: "supported" }],
      }),
    (error) => error.reason === REASON.HOST_UNDECLARED,
  );
});

// -- vector: packaged-host-selector-ignored (expect_after_fix) ---------------

test("the shipped packaged dictionary cannot be projected as embed", async () => {
  const packaged = (await readJson(packagedUrl)).primitive_dictionary;

  // Positive control: it parses correctly as what it actually declares.
  const asExtension = parseLegacyPackagedDictionary(packaged, { expectedHost: "extension" });
  assert.equal(asExtension.host, "extension");
  assert.ok(asExtension.primitives.length > 0);

  // And fails closed as what it is not -- the defect this replaces returned
  // extension authority here without objection.
  assert.throws(
    () => parseLegacyPackagedDictionary(packaged, { expectedHost: "embed" }),
    (error) => error.reason === REASON.HOST_MISMATCH && error.detail.declared === "extension",
  );
});

// -- vector: resolved-snapshot-rejects-second-host-selector ------------------

test("a resolved catalog refuses to be formatted as another host", () => {
  const catalog = { host: "extension", installation_revision: "rev-a", primitives: [] };
  assert.doesNotThrow(() => assertResolvedCatalogForHost(catalog, "extension"));
  assert.throws(
    () => assertResolvedCatalogForHost(catalog, "embed"),
    (error) => error.reason === REASON.HOST_MISMATCH,
  );
});

// -- vector: unknown-host-fails-closed ---------------------------------------

test("an unrecognised host resolves unsupported with a stated reason", async () => {
  const dictionary = await readJson(canonicalUrl);
  const resolved = resolveCapability({
    dictionary,
    hostState: { host: "no-such-host", revision: "rev-a", namespaces: {} },
    primitive: "pointer.click",
  });
  assert.equal(resolved.support, "unsupported");
  assert.equal(resolved.reason, REASON.HOST_UNKNOWN);
});

// -- vector: three-reasons-lead-to-three-remediations ------------------------

test("namespace, registration, and health are three distinct diagnoses", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";

  const noNamespace = resolveCapability({
    dictionary,
    hostState: { host: "embed", revision: "r", namespaces: {} },
    primitive,
  });
  assert.equal(noNamespace.reason, REASON.NAMESPACE_UNAVAILABLE);
  assert.equal(noNamespace.decided_by, LAYER.HOST_STATE);

  const notRegistered = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: { pointer: { provider: "example-sql", registrations: { "example-sql": { implements: [] } } } },
    },
    primitive,
  });
  assert.equal(notRegistered.reason, REASON.CAPABILITY_UNAVAILABLE);
  assert.equal(notRegistered.decided_by, LAYER.PROVIDER_REGISTRATION);

  const unhealthy = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: {
        pointer: { provider: "example-sql", health: "unavailable", registrations: { "example-sql": { implements: [primitive] } } },
      },
    },
    primitive,
  });
  assert.equal(unhealthy.reason, REASON.PROVIDER_UNAVAILABLE);
  // provider_health is a SOURCE within host_state, not a sixth layer: the
  // normative layer vocabulary is five, and the schema enforces it.
  assert.equal(unhealthy.decided_by, LAYER.HOST_STATE);
  assert.ok(
    unhealthy.decisions.some((d) => d.source === "provider_health"),
    "the trace must name provider_health as the source",
  );

  // The point of keeping them distinct: three different remediations. Any two
  // collapsing would make a transient outage read as permanent, or an
  // unfixable gap read as a configuration the user could supply.
  const reasons = new Set([noNamespace.reason, notRegistered.reason, unhealthy.reason]);
  assert.equal(reasons.size, 3);
});

// -- vector: capability-unavailable-distinguishes-registration-from-narrowing -

test("capability_unavailable names its source in the trace", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";

  const neverRegistered = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: { pointer: { provider: "p", registrations: { "p": { implements: [] } } } },
    },
    primitive,
  });

  const narrowedLater = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: { pointer: { provider: "p", registrations: { "p": { implements: [primitive] } } } },
    },
    primitive,
    callContext: { site_policy_blocks: [primitive] },
  });

  // Same top-level reason, different decided_by -- which is the whole argument
  // for the trace. A singular origin field would report these identically.
  assert.equal(neverRegistered.reason, REASON.CAPABILITY_UNAVAILABLE);
  assert.equal(narrowedLater.reason, REASON.CAPABILITY_UNAVAILABLE);
  assert.equal(neverRegistered.decided_by, LAYER.PROVIDER_REGISTRATION);
  assert.equal(narrowedLater.decided_by, LAYER.CALL_CONTEXT);

  // The narrowed one must show it WAS supported before call context spoke.
  const supportedEarlier = narrowedLater.decisions.some(
    (decision) =>
      decision.layer === LAYER.PROVIDER_REGISTRATION && decision.decision === "supported",
  );
  assert.ok(supportedEarlier, "trace must show the earlier support that was narrowed");
});

// -- vector: two-providers-one-namespace-resolve-deterministically -----------

test("two candidate providers with no selection is a stated conflict", async () => {
  const dictionary = await readJson(canonicalUrl);
  const resolved = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: { pointer: { candidates: ["provider-a", "provider-b"], selected: null } },
    },
    primitive: "pointer.click",
  });
  assert.equal(resolved.support, "unsupported");
  assert.equal(resolved.reason, REASON.PROVIDER_CONFLICT);

  // With a selection it resolves, and the trace names the rule that chose.
  const selected = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      namespaces: {
        pointer: {
          candidates: ["provider-a", "provider-b"],
          selected: "provider-b",
          registrations: { "provider-b": { implements: ["pointer.click"] } },
        },
      },
    },
    primitive: "pointer.click",
  });
  assert.equal(selected.support, "supported");
  assert.equal(selected.provider, "provider-b");
});

// -- monotonicity ------------------------------------------------------------

test("a later layer can only narrow, never widen", async () => {
  const dictionary = await readJson(canonicalUrl);

  // browser.open_tab is unsupported for embed via adapters. When the host
  // explicitly selects that legacy profile, a fully-registering namespace
  // must not be able to re-enable it.
  const resolved = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "r",
      compatibility_profile: "dictionary_adapters",
      namespaces: {
        browser: { provider: "p", registrations: { p: { implements_namespace: true } } },
      },
    },
    primitive: "browser.open_tab",
  });

  assert.equal(resolved.support, "unsupported");
  // With an explicit whole-namespace registration the compatibility override
  // is what refuses; the adapters say embed cannot open tabs.
  assert.equal(resolved.decided_by, LAYER.COMPATIBILITY_OVERRIDE);
});

test("runtime provider registration is not narrowed by an unselected legacy profile", async () => {
  const dictionary = await readJson(canonicalUrl);
  const resolved = resolveCapability({
    dictionary,
    hostState: {
      host: "embed",
      revision: "runtime-r",
      namespaces: {
        browser: { provider: "served", registrations: { served: { implements: ["browser.open_tab"] } } },
      },
    },
    primitive: "browser.open_tab",
  });

  assert.equal(resolved.support, "supported");
  assert.equal(resolved.decided_by, LAYER.PROVIDER_REGISTRATION);
});

// -- vector: canonical-extension-differs-from-embed --------------------------

test("resolved catalogs differ across hosts on authority-bound primitives", async () => {
  const dictionary = await readJson(canonicalUrl);

  const extension = resolveCatalog({
    dictionary,
    hostState: { ...openHostState(dictionary, "extension"), compatibility_profile: "dictionary_adapters" },
  });
  const embed = resolveCatalog({
    dictionary,
    hostState: { ...openHostState(dictionary, "embed"), compatibility_profile: "dictionary_adapters" },
  });

  const supported = (catalog) =>
    new Set(catalog.primitives.filter((p) => p.support === "supported").map((p) => p.primitive));

  const ext = supported(extension);
  const emb = supported(embed);

  assert.notDeepEqual([...ext].sort(), [...emb].sort());
  assert.notEqual(extension.catalog_fingerprint, embed.catalog_fingerprint);

  // Positive controls on both sides: "embed has fewer" is also consistent with
  // embed resolving to nothing, which would be a different bug wearing the
  // same numbers.
  assert.ok(ext.has("browser.open_tab"));
  assert.ok(!emb.has("browser.open_tab"));
  assert.ok(emb.has("overlay.open"));
  assert.ok(emb.has("pointer.click"));
  assert.ok(emb.has("keyboard.press"));
});

// -- vector: identical-across-hosts-only-when-decisions-match ----------------

test("identical support counts as agreement only when the traces match", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "overlay.open";

  const asExtension = resolveCapability({
    dictionary,
    hostState: openHostState(dictionary, "extension"),
    primitive,
  });
  const asEmbed = resolveCapability({
    dictionary,
    hostState: openHostState(dictionary, "embed"),
    primitive,
  });

  assert.equal(asExtension.support, "supported");
  assert.equal(asEmbed.support, "supported");
  assert.ok(agreementIsVerifiable(asExtension, asEmbed));

  // Identical support with no trace is exactly what the shipped defect
  // produces, and must not read as agreement.
  assert.ok(!agreementIsVerifiable({ support: "supported" }, { support: "supported" }));
});

// -- vector: partial-fails-validation ----------------------------------------

test("a leftover partial fails validation rather than degrading silently", () => {
  const dictionary = {
    version: 1,
    stage: 1,
    primitives: [
      {
        name: "keyboard.press",
        capability_class: "mixed",
        portable: false,
        adapters: { embed: { support: "partial", reason: "trusted_key_events_unavailable" } },
      },
    ],
  };

  assert.throws(
    () =>
      resolveCapability({
        dictionary,
        hostState: { host: "embed", revision: "r", namespaces: { keyboard: { provider: "p" } } },
        primitive: "keyboard.press",
      }),
    (error) => error.reason === "invalid_support_value",
  );
});

// -- namespace derivation ----------------------------------------------------

test("namespace derives from the dotted prefix", async () => {
  const dictionary = await readJson(canonicalUrl);
  assert.equal(namespaceOf("browser.claimed_tabs.list"), "browser");
  assert.equal(namespaceOf("overlay.open"), "overlay");

  for (const primitive of dictionary.primitives) {
    const derived = namespaceOf(primitive.name);
    assert.ok(derived.length > 0, `${primitive.name} yields an empty namespace`);
    if (primitive.namespace !== undefined) {
      assert.equal(primitive.namespace, derived, `${primitive.name} declares a divergent namespace`);
    }
  }
});

// --- Production output against the merged schemas and goldens -------------
//
// Review finding 6: the resolver emitted resolutions with no `authority`,
// catalogs with no `kind`, and an eight-hex FNV digest where the contract
// specifies a domain-separated SHA-256. Every one of those passed the corpus,
// because the corpus checks selected expectations while the schemas check the
// whole shape. Validating real resolver output -- not a fixture built to suit
// -- is the check that would have caught all three.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { createValidator } from "../../../contracts/capability-resolution/validate.mjs";

const CONTRACT = new URL("../../../contracts/capability-resolution/", import.meta.url);
const schemaId = (name) => `https://actions.json/contracts/capability-resolution/${name}`;

function contractValidator() {
  const dir = new URL("schemas/", CONTRACT);
  const validator = createValidator();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
    validator.add(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
  }
  return validator;
}

const shippedDictionary = () =>
  JSON.parse(readFileSync(new URL("../src/primitives/dictionary.v1.json", import.meta.url), "utf8"));

const hostState = () => ({
  host: "embed",
  revision: "rev-1",
  principal_id: "p",
  installation_id: "i",
  authority_mode: "owner_rights",
  namespaces: { pointer: { provider: "x", registrations: { x: { implements: ["pointer.click"] } } } },
});

test("production resolution validates against the merged resolution schema", () => {
  const validator = contractValidator();
  const resolution = resolveCapability({
    dictionary: shippedDictionary(),
    hostState: hostState(),
    primitive: "pointer.click",
  });
  assert.deepEqual(validator.validate(resolution, schemaId("resolution.schema.json")), []);
});

test("production catalog validates across every shipped primitive", () => {
  const validator = contractValidator();
  const catalog = resolveCatalog({ dictionary: shippedDictionary(), hostState: hostState() });
  // A catalog covering one primitive would validate while 42 others drifted.
  assert.ok(catalog.primitives.length > 40, `only ${catalog.primitives.length} primitives resolved`);
  assert.deepEqual(validator.validate(catalog, schemaId("resolved-catalog.schema.json")), []);
});

// Zero errors is also what a validator that checks nothing reports. Each
// mutation below reintroduces one drift the review actually found.
test("the schema rejects each drift finding 6 named", () => {
  const validator = contractValidator();
  const build = () =>
    resolveCapability({
      dictionary: shippedDictionary(),
      hostState: hostState(),
      primitive: "pointer.click",
    });

  const drifts = {
    "installation_revision hoisted out of authority": (o) => { o.installation_revision = "rev-1"; },
    "source outside the closed layer vocabulary": (o) => { o.decisions[1].source = "configured"; },
    "authority omitted entirely": (o) => { delete o.authority; },
    "eight-hex FNV fingerprint": (o) => { o.fingerprint = "cat-d099c5f5"; },
  };

  for (const [name, mutate] of Object.entries(drifts)) {
    const mutated = build();
    mutate(mutated);
    const errors = validator.validate(mutated, schemaId("resolution.schema.json"));
    assert.ok(errors.length > 0, `schema accepted a known drift: ${name}`);
  }
});

// The digest matched /^cat-[0-9a-f]{32}$/ while being wrong in two ways: JS
// default sort is UTF-16 code-unit order, not the spec's byte-wise UTF-8, and
// an absent `decided_by` emitted the literal "undefined". Shape is not identity
// -- only the goldens' preimages catch that.
test("fingerprint reproduces the committed catalog goldens", () => {
  const goldens = JSON.parse(readFileSync(new URL("schemas/golden-fingerprints.json", CONTRACT), "utf8"));
  const cases = goldens.cases.filter((c) => c.kind === "catalog_fingerprint");
  assert.ok(cases.length >= 3, `expected catalog goldens, found ${cases.length}`);
  for (const golden of cases) {
    assert.equal(fingerprint(golden.records), golden.expected, golden.description);
  }
});

test("fingerprint follows fingerprint.spec.md rather than JS defaults", () => {
  // decided_by is in the preimage precisely so identical support reached
  // through different layers is not the same catalog.
  const support = (decidedBy) => [`a.one\tsupported\t\t${decidedBy}\t`];
  assert.notEqual(
    fingerprint(support("provider_registration")),
    fingerprint(support("compatibility_override")),
    "decided_by does not affect the digest",
  );

  // An absent field emits the empty string, never "undefined".
  assert.equal(
    fingerprint([{ primitive: "a.one", support: "supported" }]),
    fingerprint(["a.one\tsupported\t\t\t"]),
    "an absent field is not the empty string",
  );

  // Byte-wise UTF-8 ordering disagrees with UTF-16 code-unit order above
  // U+FFFF: "\u{10000}" sorts after "＀" by bytes and before it by code
  // units. Array.prototype.sort() gets this wrong.
  const records = ["\u{10000}\tsupported\t\tprovider_registration\t", "＀\tsupported\t\tprovider_registration\t"];
  const byBytes =
    "actions-json/catalog-fingerprint/v2\n" +
    [...records].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
      .map((line) => `${line}\n`).join("");
  assert.equal(
    fingerprint(records),
    `cat-${createHash("sha256").update(byBytes, "utf8").digest("hex").slice(0, 32)}`,
  );
});

test("the catalog digest moves when resolved support moves", () => {
  const dictionary = shippedDictionary();
  const pointerPrimitives = dictionary.primitives
    .map((p) => p.name ?? p.primitive)
    .filter((n) => n.startsWith("pointer."));
  assert.ok(pointerPrimitives.length >= 2, "need two real primitives to discriminate");

  const catalogFor = (implemented) =>
    resolveCatalog({
      dictionary,
      hostState: { ...hostState(), namespaces: { pointer: { provider: "x", registrations: { x: { implements: implemented } } } } },
    });

  const one = catalogFor([pointerPrimitives[0]]);
  const two = catalogFor(pointerPrimitives.slice(0, 2));
  const supported = (c) => c.primitives.filter((p) => p.support === "supported").map((p) => p.primitive).sort();

  // Positive control: a digest comparison proves nothing if the two catalogs
  // resolved identically. An earlier version of this check mutated a primitive
  // that is not in the dictionary, so equal digests were the correct answer.
  assert.notDeepEqual(supported(one), supported(two), "the two catalogs resolved alike");
  assert.notEqual(one.catalog_fingerprint, two.catalog_fingerprint);
});

test("selected provider descriptor becomes the effective executable contract", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  assert.ok(canonical);
  const input_schema = structuredClone(canonical.input_schema);
  input_schema.properties.button.enum = ["left"];
  input_schema.properties.provider_only = { type: "boolean" };
  const descriptor = {
    summary: "Click through the selected provider contract.",
    input_schema,
    extensions: {
      input: {
        provider_only: { authority: "additional_policy", effect: "same_as_primitive" },
      },
    },
  };
  const hostState = {
    host: "embed",
    revision: "rev-descriptor",
    installation_id: "installation-1",
    principal_id: "principal-1",
    authority_mode: "caller_rights",
    namespaces: {
      pointer: {
        provider: "selected",
        registrations: {
          selected: { implements: [primitive], descriptors: { [primitive]: descriptor } },
          ignored: {
            implements: [primitive],
            descriptors: { [primitive]: { input_schema: { type: "array" } } },
          },
        },
      },
    },
  };

  const resolved = resolveCapability({ dictionary, hostState, primitive });
  assert.deepEqual(
    contractValidator().validate(hostState, schemaId("host-state.schema.json")),
    [],
  );
  assert.equal(resolved.support, "supported");
  assert.equal(resolved.descriptor.source, "provider_registration");
  assert.equal(resolved.descriptor.summary, descriptor.summary);
  assert.deepEqual(resolved.descriptor.input_schema, input_schema);
  assert.deepEqual(resolved.descriptor.provider_extensions, descriptor.extensions.input);
});

test("provider descriptor additions fail closed without authority and effect declarations", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const input_schema = structuredClone(canonical.input_schema);
  input_schema.properties.silent_extra = { type: "boolean" };
  const hostState = {
    host: "embed",
    revision: "rev-descriptor",
    namespaces: {
      pointer: {
        provider: "provider-a",
        registrations: {
          "provider-a": { implements: [primitive], descriptors: { [primitive]: { input_schema } } },
        },
      },
    },
  };
  assert.throws(
    () => resolveCapability({ dictionary, hostState, primitive }),
    (error) => error instanceof CapabilityContractError && error.reason === "undeclared_provider_extension",
  );
});

test("provider descriptor cannot silently retype a canonical parameter", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const input_schema = structuredClone(canonical.input_schema);
  const parameter = Object.keys(input_schema.properties)[0];
  input_schema.properties[parameter] = { type: "null" };
  const hostState = {
    host: "embed",
    revision: "rev-descriptor",
    namespaces: {
      pointer: {
        provider: "provider-a",
        registrations: {
          "provider-a": { implements: [primitive], descriptors: { [primitive]: { input_schema } } },
        },
      },
    },
  };
  assert.throws(
    () => resolveCapability({ dictionary, hostState, primitive }),
    (error) => error instanceof CapabilityContractError && error.reason === "incompatible_provider_descriptor",
  );
});

test("provider descriptor compatibility failures cover every fail-closed boundary", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  assert.ok(canonical);

  const resolveWith = (descriptor, implemented = [primitive]) =>
    resolveCapability({
      dictionary,
      hostState: {
        host: "embed",
        revision: "rev-descriptor",
        namespaces: {
          pointer: {
            provider: "provider-a",
            registrations: {
              "provider-a": {
                implements: implemented,
                descriptors: { [primitive]: descriptor },
              },
            },
          },
        },
      },
      primitive,
    });

  const reopened = structuredClone(canonical.input_schema);
  reopened.additionalProperties = true;
  assert.throws(
    () => resolveWith({ input_schema: reopened }),
    (error) => error instanceof CapabilityContractError && error.reason === "incompatible_provider_descriptor",
  );

  const droppedRequired = structuredClone(canonical.input_schema);
  const requiredParameter = Object.keys(droppedRequired.properties)[0];
  const canonicalWithRequired = {
    ...structuredClone(canonical),
    input_schema: { ...structuredClone(canonical.input_schema), required: [requiredParameter] },
  };
  droppedRequired.required = [];
  assert.throws(
    () => resolveCapability({
      dictionary: {
        ...dictionary,
        primitives: dictionary.primitives.map((entry) => entry.name === primitive ? canonicalWithRequired : entry),
      },
      hostState: {
        host: "embed",
        revision: "rev-descriptor",
        namespaces: {
          pointer: {
            provider: "provider-a",
            registrations: {
              "provider-a": {
                implements: [primitive],
                descriptors: { [primitive]: { input_schema: droppedRequired } },
              },
            },
          },
        },
      },
      primitive,
    }),
    (error) => error instanceof CapabilityContractError && error.reason === "incompatible_provider_descriptor",
  );

  const invalidDeclaration = structuredClone(canonical.input_schema);
  assert.throws(
    () => resolveWith({
      input_schema: invalidDeclaration,
      extensions: { input: { phantom: { authority: "additional_policy", effect: "mutation" } } },
    }),
    (error) => error instanceof CapabilityContractError && error.reason === "invalid_provider_extension",
  );

  assert.throws(
    () => resolveWith({ output_schema: { type: "object" } }),
    (error) => error instanceof CapabilityContractError && error.reason === "incompatible_provider_descriptor",
  );

  const outputChanged = {
    ...structuredClone(canonical),
    output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
  };
  const dictionaryWithOutput = {
    ...dictionary,
    primitives: dictionary.primitives.map((entry) => entry.name === primitive ? outputChanged : entry),
  };
  const changedOutput = structuredClone(outputChanged.output_schema);
  changedOutput.properties.ok.type = "string";
  assert.throws(
    () => resolveCapability({
      dictionary: dictionaryWithOutput,
      hostState: {
        host: "embed",
        revision: "rev-descriptor",
        namespaces: {
          pointer: {
            provider: "provider-a",
            registrations: {
              "provider-a": {
                implements: [primitive],
                descriptors: { [primitive]: { output_schema: changedOutput } },
              },
            },
          },
        },
      },
      primitive,
    }),
    (error) => error instanceof CapabilityContractError && error.reason === "incompatible_provider_descriptor",
  );
});

test("provider descriptor identity moves the catalog fingerprint", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const stateWith = (summary) => ({
    host: "embed",
    revision: "rev-same",
    namespaces: {
      pointer: {
        provider: "p",
        registrations: {
          p: { implements: [primitive], descriptors: { [primitive]: { summary } } },
        },
      },
    },
  });
  const left = resolveCatalog({ dictionary, hostState: stateWith("Provider A click") });
  const right = resolveCatalog({ dictionary, hostState: stateWith("Provider B click") });
  assert.equal(left.primitives.find((entry) => entry.primitive === primitive).support, "supported");
  assert.equal(right.primitives.find((entry) => entry.primitive === primitive).support, "supported");
  assert.notEqual(left.catalog_fingerprint, right.catalog_fingerprint);
  assert.notEqual(canonical.summary, "Provider A click");
});

test("whole-namespace registration rejects descriptors outside its namespace", async () => {
  const dictionary = await readJson(canonicalUrl);
  assert.throws(
    () => resolveCapability({
      dictionary,
      hostState: {
        host: "embed",
        revision: "rev-whole-namespace",
        namespaces: {
          pointer: {
            provider: "p",
            registrations: {
              p: {
                implements_namespace: true,
                descriptors: { "browser.open_tab": { summary: "Not pointer" } },
              },
            },
          },
        },
      },
      primitive: "pointer.click",
    }),
    (error) => error instanceof CapabilityContractError && error.reason === "invalid_provider_descriptor",
  );
});

test("provider extension authority and mutation effect are enforced at call resolution", () => {
  const primitive = "data.query";
  const dictionary = {
    kind: "canonical",
    primitives: [{
      name: primitive,
      namespace: "data",
      capability_class: "privileged",
      portable: false,
      effect: "read_only",
      summary: "Run a named query",
      input_schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    }],
  };
  const input_schema = structuredClone(dictionary.primitives[0].input_schema);
  input_schema.properties.write_back = { type: "boolean" };
  const hostState = {
    host: "embed",
    revision: "rev-extension-effect",
    preflight: "durable_mutation_store_ready",
    namespaces: {
      data: {
        provider: "p",
        registrations: {
          p: {
            implements: [primitive],
            descriptors: {
              [primitive]: {
                input_schema,
                extensions: {
                  input: {
                    write_back: { authority: "additional_policy", effect: "mutation" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const denied = resolveCapability({
    dictionary,
    hostState,
    primitive,
    callContext: { arguments: { name: "q", write_back: true } },
  });
  assert.equal(denied.support, "unsupported");
  assert.equal(denied.decided_by, "call_context");

  const allowed = resolveCapability({
    dictionary,
    hostState,
    primitive,
    callContext: {
      arguments: { name: "q", write_back: true },
      provider_extension_policies: { [primitive]: ["write_back"] },
    },
  });
  assert.equal(allowed.support, "supported");
  assert.equal(allowed.effect, "mutation");
});
