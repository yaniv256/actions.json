// The embed host as a second runtime: the check on whether the host
// abstraction generalised, rather than an assertion that it did.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EmbedHost,
  PrimitiveRegistry,
  ReceiptLedger,
  effectiveHostRevision,
} from "../src/embed/embed-host.mjs";
import { namespaceOf } from "../src/primitives/capability-resolver.mjs";

const canonicalUrl = new URL("../src/primitives/dictionary.v1.json", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

const hostStateFor = (dictionary, namespaces) => ({
  host: "embed",
  revision: "rev-1",
  // These characterization tests intentionally exercise the canonical
  // dictionary's legacy per-host adapter projection. Live provider-backed
  // hosts omit this profile and derive availability from registration.
  compatibility_profile: "dictionary_adapters",
  namespaces:
    namespaces ??
    Object.fromEntries(
      [...new Set(dictionary.primitives.map((p) => namespaceOf(p.name)))].map((ns) => [
        ns,
        { provider: `${ns}-provider`, registrations: { [`${ns}-provider`]: { implements_namespace: true } } },
      ]),
    ),
});

const collector = () => {
  const sent = [];
  return { sent, send: (item) => sent.push(item) };
};

test("registry refuses a duplicate handler", () => {
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({ ok: true }));
  assert.throws(() => registry.register("overlay.open", async () => ({ ok: true })), /already registered/);
});

test("EmbedHost refuses to be constructed for another host", async () => {
  const dictionary = await readJson(canonicalUrl);
  assert.throws(
    () =>
      new EmbedHost({
        dictionary,
        hostState: { host: "extension", revision: "r", namespaces: {} },
        send: () => {},
      }),
    /requires hostState.host === "embed"/,
  );
});

test("the catalog is the intersection of granted and implemented", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({ ok: true }));
  registry.register("pointer.click", async () => ({ ok: true }));

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send: () => {},
  });

  const catalog = host.catalog();

  assert.deepEqual(catalog.advertised, ["overlay.open", "pointer.click"]);

  // Granted-but-unimplemented is REPORTED, not silently dropped. This is the
  // corpus.search state made visible: advertised, packaged, green on every
  // test, handler_failed on the first real call.
  assert.ok(catalog.granted_but_unimplemented.length > 0);
  assert.ok(catalog.granted_but_unimplemented.includes("dom.list_sections"));

  // And nothing this host implements exceeds what it was granted.
  assert.deepEqual(catalog.implemented_but_ungranted, []);
});

test("the live embed registry publishes its provider descriptor into the resolved catalog", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const input_schema = structuredClone(canonical.input_schema);
  input_schema.properties.provider_only = { type: "boolean" };
  const descriptor = {
    summary: "Provider-bound click",
    input_schema,
    extensions: {
      input: {
        provider_only: { authority: "same_as_primitive", effect: "same_as_primitive" },
      },
    },
  };
  const registry = new PrimitiveRegistry();
  registry.register(primitive, async () => ({ ok: true }), {
    provider: "pointer-provider",
    providerRevision: `sha256:${"d".repeat(64)}`,
    descriptor,
  });
  const hostState = {
    host: "embed",
    revision: "rev-registry-descriptor",
    namespaces: {
      pointer: {
        provider: "pointer-provider",
        registrations: {
          "pointer-provider": { implements: [primitive] },
        },
      },
    },
  };
  const host = new EmbedHost({ dictionary, hostState, registry, send: () => {} });
  const resolved = host.catalog().primitives.find((entry) => entry.primitive === primitive);
  assert.equal(resolved.support, "supported");
  assert.equal(resolved.descriptor.summary, descriptor.summary);
  assert.deepEqual(resolved.descriptor.input_schema, input_schema);
  assert.deepEqual(
    hostState.namespaces.pointer.registrations["pointer-provider"].descriptors[primitive],
    descriptor,
  );
  descriptor.summary = "mutated after registration";
  assert.equal(host.catalog().primitives.find((entry) => entry.primitive === primitive).descriptor.summary, "Provider-bound click");
});

test("the embed execution boundary validates arguments against the selected provider descriptor", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const input_schema = structuredClone(canonical.input_schema);
  input_schema.properties.provider_only = { type: "boolean" };
  const registry = new PrimitiveRegistry();
  let invocations = 0;
  registry.register(primitive, async () => { invocations += 1; return { ok: true }; }, {
    provider: "pointer-provider",
    providerRevision: `sha256:${"e".repeat(64)}`,
    descriptor: {
      input_schema,
      extensions: { input: { provider_only: { authority: "same_as_primitive", effect: "same_as_primitive" } } },
    },
  });
  const host = new EmbedHost({
    dictionary,
    hostState: {
      host: "embed",
      revision: "rev-argument-validation",
      namespaces: { pointer: { provider: "pointer-provider", registrations: { "pointer-provider": { implements: [primitive] } } } },
    },
    registry,
    send: () => {},
  });
  const result = await host.handleActionCall({
    call_id: "invalid-provider-argument",
    primitive,
    arguments: { x: 1, y: 2, provider_only: "yes" },
  });
  assert.equal(result.error.code, "invalid_arguments");
  assert.equal(invocations, 0);
});

test("whole-namespace registrations publish registry descriptors for that namespace only", async () => {
  const dictionary = await readJson(canonicalUrl);
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const registry = new PrimitiveRegistry();
  registry.register(primitive, async () => ({ ok: true }), {
    provider: "pointer-provider",
    providerRevision: `sha256:${"f".repeat(64)}`,
    descriptor: { summary: "Whole namespace click", input_schema: canonical.input_schema },
  });
  const host = new EmbedHost({
    dictionary,
    hostState: {
      host: "embed",
      revision: "rev-whole-namespace",
      namespaces: { pointer: { provider: "pointer-provider", registrations: { "pointer-provider": { implements_namespace: true } } } },
    },
    registry,
    send: () => {},
  });
  const resolved = host.catalog().primitives.find((entry) => entry.primitive === primitive);
  assert.equal(resolved.support, "supported");
  assert.equal(resolved.descriptor.summary, "Whole namespace click");
});

test("a handler implemented but not granted is reported rather than advertised", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("browser.open_tab", async () => ({ ok: true }));

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send: () => {},
  });

  const catalog = host.catalog();
  assert.ok(!catalog.advertised.includes("browser.open_tab"));
  assert.deepEqual(catalog.implemented_but_ungranted, ["browser.open_tab"]);
});

test("an ungranted primitive is refused with its reason and trace", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("browser.open_tab", async () => ({ ok: true }));
  const { sent, send } = collector();

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send,
  });

  const result = await host.handleActionCall({ call_id: "c1", name: "browser.open_tab" });

  assert.equal(result.type, "action_error");
  assert.equal(result.error.code, "capability_unavailable");
  // The DIAGNOSIS crosses the boundary; the trace does not. `decisions` names
  // providers, and a browser needs to know what to do rather than which
  // internal layer decided it -- the full trace stays host-side behind the
  // correlation id.
  assert.ok(result.error.decided_by, "a refusal must name the layer that decided");
  assert.ok(result.error.reason, "a refusal must carry its reason");
  assert.ok(result.error.remediation, "a refusal must say what can be done");
  assert.equal(result.error.decisions, undefined, "the raw trace must not reach the browser");
  assert.equal(sent.length, 1);

  // The handler exists and still did not run: authority is resolved at the
  // executing boundary, not read from a catalog the caller happens to hold.
});

test("granted but unimplemented gets its own error code", async () => {
  const dictionary = await readJson(canonicalUrl);
  const { sent, send } = collector();

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry: new PrimitiveRegistry(),
    send,
  });

  const result = await host.handleActionCall({ call_id: "c2", name: "overlay.open" });
  assert.equal(result.error.code, "handler_missing");
  assert.equal(sent.length, 1);
});

test("a granted, implemented primitive executes and emits the output envelope", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async (args) => ({ overlay_id: args.id ?? "o1" }));
  const { sent, send } = collector();

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send,
  });

  const result = await host.handleActionCall({
    call_id: "c3",
    name: "overlay.open",
    arguments: { title: "report" },
  });

  assert.equal(result.type, "action_call_output");
  assert.equal(result.call_id, "c3");
  assert.deepEqual(result.output, { overlay_id: "o1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "action_call_output");
});

test("a throwing handler becomes handler_failed, not a crash", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => {
    throw new Error("overlay host not mounted");
  });
  const { send } = collector();

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send,
  });

  const result = await host.handleActionCall({ call_id: "c4", name: "overlay.open" });
  assert.equal(result.error.code, "handler_failed");
  // The raw message deliberately does NOT cross the boundary: it can carry
  // SQL, account identifiers or paths, and this envelope reaches a browser.
  assert.doesNotMatch(result.error.message, /overlay host not mounted/);
  assert.match(result.error.message, /handler raised an error/);
  assert.equal(result.error.raw_available_in, "host_diagnostics");
});

test("withdrawing a namespace mid-session refuses the next call without wedging", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({ ok: true }));
  const { send } = collector();

  const hostState = hostStateFor(dictionary);
  const host = new EmbedHost({ dictionary, hostState, registry, send });

  const before = await host.handleActionCall({ call_id: "a", name: "overlay.open" });
  assert.equal(before.type, "action_call_output");

  // The capability is withdrawn after the catalog was issued. The advertised
  // tool is still in the model's context; the call must fail cleanly rather
  // than execute with authority that has been taken away.
  delete hostState.namespaces.overlay;
  hostState.revision = "rev-2";

  const after = await host.handleActionCall({ call_id: "b", name: "overlay.open" });
  assert.equal(after.error.code, "capability_unavailable");
  assert.equal(after.error.reason, "namespace_unavailable");
  assert.equal(after.error.installation_revision, "rev-2", "the refusal carries the new revision");
});

test("a stale revision does not by itself block a still-granted call", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({ ok: true }));
  const { send } = collector();

  const hostState = hostStateFor(dictionary);
  const host = new EmbedHost({ dictionary, hostState, registry, send });

  // A harmless change moves the revision. The caller still holds the old one.
  hostState.revision = "rev-99";

  const result = await host.handleActionCall({ call_id: "c", name: "overlay.open" });
  assert.equal(
    result.type,
    "action_call_output",
    "revision is a refresh trigger, not a call precondition",
  );
});

test("signals honour the declared ingestion gate", async () => {
  const dictionary = await readJson(canonicalUrl);
  const { sent, send } = collector();
  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    send,
  });

  const signals = [
    { name: "overlay.closed", ingestion: "enabled" },
    { name: "overlay.minimized", ingestion: "disabled" },
  ];
  // The manifest is bound at construction; a caller cannot supply the
  // declaration that authorizes its own emission.
  const gated = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    send,
    signalManifest: signals,
  });

  const enabled = gated.emitSignal("overlay.closed", { overlay_id: "o1" });
  assert.equal(enabled.emitted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "dom_event");
  assert.deepEqual(sent[0].payload, { overlay_id: "o1" });

  // The gate is applied rather than declared and ignored. In the extension
  // runtime `ingestion` is read by no code at all.
  const disabled = gated.emitSignal("overlay.minimized", {});
  assert.equal(disabled.emitted, false);
  assert.equal(disabled.reason, "ingestion_disabled");
  assert.equal(sent.length, 1, "a disabled signal must not reach the wire");

  const undeclared = gated.emitSignal("overlay.invented", {});
  assert.equal(undeclared.emitted, false);
  assert.equal(undeclared.reason, "signal_not_declared");
  assert.equal(sent.length, 1);
});

test("the host refuses to format its catalog as another host", async () => {
  const dictionary = await readJson(canonicalUrl);
  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    send: () => {},
  });

  const catalog = host.catalog();
  assert.doesNotThrow(() => host.formatCatalogFor(catalog, "embed"));
  assert.throws(
    () => host.formatCatalogFor(catalog, "extension"),
    (error) => error.reason === "host_mismatch",
  );
});

test("this host is granted no browser or transfer authority", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  // Register everything the dictionary defines, so the only thing standing
  // between the agent and browser authority is the resolver.
  for (const primitive of dictionary.primitives) {
    registry.register(primitive.name, async () => ({ ok: true }));
  }

  const host = new EmbedHost({
    dictionary,
    hostState: hostStateFor(dictionary),
    registry,
    send: () => {},
  });

  const advertised = host.catalog().advertised;

  // The defect this whole track exists to remove: the shipped packaged
  // dictionary advertises all of these to an embed host.
  for (const forbidden of [
    "browser.open_tab",
    "browser.navigate",
    "browser.close_tab",
    "browser.claimed_tabs.list",
    "transfer.write",
    "transfer.read",
  ]) {
    assert.ok(!advertised.includes(forbidden), `embed must not be advertised ${forbidden}`);
  }

  // Positive control on the same list: an embed host that advertised nothing
  // would pass every assertion above for the wrong reason.
  for (const expected of ["overlay.open", "pointer.click", "dom.list_sections", "keyboard.press"]) {
    assert.ok(advertised.includes(expected), `embed should be advertised ${expected}`);
  }
});

test("two principals cannot share a receipt", async () => {
  // Rewritten: authority is no longer something a caller supplies. Two
  // principals are two HOSTS with two trusted bindings, because the browser
  // choosing its own principal is the bypass this change removed.
  const dictionary = await readJson(canonicalUrl);
  let invocations = 0;
  const store = new ReceiptLedger();

  const hostFor = (principal) => {
    const registry = new PrimitiveRegistry();
    registry.register("overlay.open", async () => {
      invocations += 1;
      return { ok: true };
    });
    return new EmbedHost({
      dictionary,
      hostState: {
        ...hostStateFor(dictionary),
        principal_id: principal,
        tenant_id: "t-1",
        installation_id: "inst-1",
        authority_mode: "owner_rights",
      },
      registry,
      ledger: store,
      send: async () => {},
      scope: { continuation_id: "cont-1" },
    });
  };

  const call = { call_id: "c-1", primitive: "overlay.open", arguments: {} };
  await hostFor("principal-a").handleActionCall(call);
  await hostFor("principal-b").handleActionCall(call);

  // Same continuation, same call id, different authenticated principal: two
  // executions, because they are two authorities and neither may replay the
  // other's receipt.
  assert.equal(invocations, 2, "a different principal must not consume another's receipt");

  // Positive control: the SAME principal replays rather than re-executing.
  await hostFor("principal-a").handleActionCall(call);
  assert.equal(invocations, 2, "the same authority must replay its receipt");
});

test("a reservation that never settled refuses rather than silently retrying", async () => {
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  let invocations = 0;
  registry.register("overlay.open", async () => {
    invocations += 1;
    return { ok: true };
  });

  const ledger = new ReceiptLedger();
  const { authorityKey: key, requestDigest: digest } = await import("../src/embed/embed-host.mjs");

  // The trusted binding comes from host state now, so the pre-reservation must
  // be written under the key the HOST derives -- a caller-built scope is no
  // longer authority and would simply miss.
  const trusted = {
    installation_id: "inst-1", tenant_id: "t-1",
    principal_id: "principal-a", authority_mode: "owner_rights",
  };
  const host = new EmbedHost({
    dictionary,
    hostState: { ...hostStateFor(dictionary), ...trusted },
    registry,
    ledger,
    send: async () => {},
    scope: { continuation_id: "cont-1" },
  });

  const crashKey = key({ ...trusted, continuation_id: "cont-1" });
  ledger.reserve(
    crashKey,
    "c-crash",
    digest({ primitive: "overlay.open", arguments: {}, primitive_version: null }),
    { provider: "p", primitive_version: null, effect: null },
  );
  // Liveness is a lease: the process that would announce its own death is the
  // one that died, so the owner is expired rather than flagged.
  ledger.loseOwner(crashKey, "c-crash");

  const result = await host.handleActionCall({
    call_id: "c-crash", primitive: "overlay.open", arguments: {},
  });

  assert.equal(result.error.code, "unknown_disposition");
  assert.equal(invocations, 0, "an unknown disposition must not re-execute");
});

test("reserve is one atomic step, not lookup-then-write", async () => {
  const ledger = new ReceiptLedger();
  const scope = { tenant_id: "t", principal_id: "p", session_id: "s", runtime_id: "r" };

  // The first caller wins; every subsequent caller is told who holds it. A
  // lookup-then-write store would let two callers both observe "absent".
  const { authorityKey: key } = await import("../src/embed/embed-host.mjs");
  const k = key(scope);

  // Acquisition issues an owner token; a second caller sees the live owner.
  const first = ledger.reserve(k, "c-1", "d");
  assert.equal(first.state, "acquired");
  assert.ok(first.owner_token, "acquisition must issue an owner token");
  assert.equal(ledger.reserve(k, "c-1", "d").state, "in_flight");
  assert.equal(ledger.reserve(k, "c-1", "other-digest").state, "conflict");

  // Once the owner is lost, the disposition is unresolved rather than free.
  ledger.loseOwner(k, "c-1");
  assert.equal(ledger.reserve(k, "c-1", "d").state, "unknown_disposition");

  // Positive control: a different call id is unaffected.
  assert.equal(ledger.reserve(k, "c-2", "d").state, "acquired");
});

test("the wire envelope cannot choose receipt authority", async () => {
  // Reproduced from her review before fixing: the browser supplied scope
  // through withScope() and call.scope, so it could replace installation,
  // tenant, continuation, session, principal (by omission) and authority mode
  // -- and that gave a SECOND execution of the same call_id, defeating
  // mutation idempotency from the untrusted side.
  const dictionary = await readJson(canonicalUrl);
  const registry = new PrimitiveRegistry();
  let invocations = 0;
  registry.register("overlay.open", async () => {
    invocations += 1;
    return { ok: true };
  });

  const host = new EmbedHost({
    dictionary,
    hostState: {
      ...hostStateFor(dictionary),
      principal_id: "alice", tenant_id: "t-1",
      installation_id: "inst-1", authority_mode: "owner_rights",
    },
    registry,
    ledger: new ReceiptLedger(),
    send: async () => {},
    scope: { continuation_id: "cont-1" },
  });

  const call = { call_id: "c-1", primitive: "overlay.open", arguments: {} };
  await host.handleActionCall(call);

  // Every authority field the browser could previously override.
  await host.handleActionCall({
    ...call,
    scope: {
      tenant_id: "other", installation_id: "other",
      continuation_id: "other", authority_mode: "caller_rights",
    },
  });

  assert.equal(invocations, 1, "the wire envelope chose its own receipt authority");

  // A claimed principal that is not the authenticated one is refused outright
  // rather than silently ignored -- an explicit claim is a different case from
  // an opaque token.
  const refused = await host.withScope({ principal_id: "mallory" }).handleActionCall({
    ...call, call_id: "c-2",
  });
  assert.equal(refused.error.code, "principal_mismatch");
  assert.equal(invocations, 1);
});

test("a mutation refuses when no durable store is injected", async () => {
  // preflight: durable_mutation_store_ready is a claim about the deployment,
  // and a claim is not a store. The host previously trusted its own
  // configuration instead of the object that would record the receipt.
  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [
      { name: "data.write", capability_class: "privileged", portable: false, effect: "mutation" },
      { name: "data.query", capability_class: "portable", portable: true, effect: "read_only" },
    ],
  };
  const build = (ledger) => {
    const registry = new PrimitiveRegistry();
    const counter = { n: 0 };
    for (const primitive of fixture.primitives) {
      registry.register(primitive.name, async () => {
        counter.n += 1;
        return { ok: true };
      });
    }
    return {
      host: new EmbedHost({
        dictionary: fixture, registry, ledger, send: async () => {},
        hostState: {
          host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
          preflight: "durable_mutation_store_ready",
          namespaces: { data: { provider: "x", registrations: { x: { implements: ["data.write", "data.query"] } } } },
        },
      }),
      counter,
    };
  };

  const noStore = build(null);
  const refused = await noStore.host.handleActionCall({ call_id: "a", primitive: "data.write", arguments: {} });
  assert.equal(noStore.counter.n, 0, "a mutation ran with no receipt custody");
  assert.equal(refused.error.reason, "durable_store_unavailable");

  // Reads need no receipt, so a store-less host stays useful.
  const reading = build(null);
  await reading.host.handleActionCall({ call_id: "b", primitive: "data.query", arguments: {} });
  assert.equal(reading.counter.n, 1);

  // Positive control: with a store, the mutation proceeds.
  const stored = build(new ReceiptLedger());
  await stored.host.handleActionCall({ call_id: "c", primitive: "data.write", arguments: {} });
  assert.equal(stored.counter.n, 1);
});

test("success never crosses the browser boundary before settlement", async () => {
  // A failed settle previously produced BOTH a visible action_call_output and
  // a reconcile_required: the browser was told the call completed, then told
  // to reconcile something it believed had finished.
  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "p.go", capability_class: "portable", portable: true, effect: "read_only" }],
  };
  const registry = new PrimitiveRegistry();
  registry.register("p.go", async () => ({ ok: true }));

  const sent = [];
  const failingStore = {
    inspect: () => ({ state: "absent" }),
    reserve: () => ({ state: "acquired", owner_token: "t" }),
    settle: () => ({ ok: false, reason: "wrong_owner" }),
  };

  const host = new EmbedHost({
    dictionary: fixture, registry, ledger: failingStore,
    send: async (item) => { sent.push(item.type); },
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      namespaces: { p: { provider: "x", registrations: { x: { implements: ["p.go"] } } } },
    },
  });

  const result = await host.handleActionCall({ call_id: "c-1", primitive: "p.go", arguments: {} });

  assert.ok(!sent.includes("action_call_output"), "success crossed the boundary before settlement");
  assert.deepEqual(sent, ["action_error"]);
  assert.equal(result.error.code, "reconcile_required");
});

test("nothing crossing the browser boundary carries raw identity", async () => {
  // Her reproduction returned `snowflake-account-prod.secret-db` at multiple
  // depths. The projection helpers existed in the contract and the host never
  // called them -- and testing forbidden key NAMES does not catch a sensitive
  // value sitting under a permitted key like `provider`.
  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "d.q", capability_class: "portable", portable: true, effect: "read_only" }],
  };
  const registry = new PrimitiveRegistry();
  registry.register("d.q", async () => ({
    ok: true,
    config_ref: "keychain://prod",
    nested: { account_locator: "acct-1.us-east-1" },
  }));

  const host = new EmbedHost({
    dictionary: fixture, registry, send: async () => {},
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      namespaces: {
        d: {
          provider: "snowflake-account-prod.secret-db",
          registrations: { "snowflake-account-prod.secret-db": { implements: ["d.q"] } },
        },
      },
    },
  });

  const catalog = JSON.stringify(host.catalog());
  assert.ok(!catalog.includes("secret-db"), "the catalog leaked a raw provider identity");

  const result = await host.handleActionCall({ call_id: "c", primitive: "d.q", arguments: {} });
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes("keychain"), "output leaked a config reference");
  assert.ok(!blob.includes("acct-1"), "output leaked a nested account locator");

  // Positive control: the projection did not simply empty everything.
  assert.ok(blob.includes("ok"), "the projection removed the payload as well");
});

test("a handler runs under the provider resolution selected", async () => {
  // PrimitiveRegistry was keyed by primitive alone, so the provider chosen by
  // resolution and the handler that actually ran were unrelated: two providers
  // registering one primitive meant one silently executed the other's code,
  // while the immutable execution binding recorded the wrong one.
  const registry = new PrimitiveRegistry();
  registry.register("data.query", async () => "unbound");
  registry.register("data.query", async () => "snowflake", { provider: "snowflake" });

  assert.equal(await registry.get("data.query", "snowflake")(), "snowflake");
  // An unbound registration is the migration shape and still serves a
  // provider it was not bound to.
  assert.equal(await registry.get("data.query", "postgres")(), "unbound");
  assert.equal(await registry.get("data.query")(), "unbound");

  // The advertised surface is primitives, not provider-qualified keys.
  assert.deepEqual(registry.names(), ["data.query"]);
});

test("a caller-chosen continuation cannot reach another scope's receipts", async () => {
  // My previous fix blocked `call.scope` and left `withScope` free -- and my
  // own test exercised the path I had already closed, so the bypass survived
  // a commit that claimed to fix it. Reproduced by her: same call_id, same
  // arguments, a different caller continuation, two successful mutations.
  const { DurableReceiptStore } = await import("../src/embed/embed-host.mjs");
  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{
      name: "data.write", capability_class: "privileged", portable: false, effect: "mutation",
      input_schema: { type: "object", properties: { row: { type: "integer" } }, additionalProperties: false },
    }],
  };
  const store = new DurableReceiptStore();
  const counter = { n: 0 };
  const build = () => {
    const registry = new PrimitiveRegistry();
    registry.register("data.write", async () => {
      counter.n += 1;
      return { ok: true };
    });
    return new EmbedHost({
      dictionary: fixture, registry, ledger: store, send: async () => {},
      hostState: {
        host: "embed", revision: "r", principal_id: "alice",
        tenant_id: "t-1", installation_id: "inst-1", authority_mode: "owner_rights",
        preflight: "durable_mutation_store_ready",
        namespaces: { data: { provider: "x", registrations: { x: { implements: ["data.write"] } } } },
      },
      scope: { continuation_id: "good" },
    });
  };

  const call = { call_id: "c-1", primitive: "data.write", arguments: { row: 1 } };
  await build().handleActionCall(call);

  // Reconstruction: a NEW host reaches the same scope, because the
  // presented-token mapping is durable rather than per-host. Without that,
  // every rerun mints a fresh scope and replay is impossible.
  await build().handleActionCall(call);
  assert.equal(counter.n, 1, "reconstruction must replay, not re-execute");

  // A different presented token gets its OWN scope. Two executions here is
  // correct: the security property is that it cannot reach the first scope's
  // receipts, not that it is refused.
  await build().withScope({ continuation_id: "evil" }).handleActionCall(call);
  assert.equal(counter.n, 2, "a foreign token must not consume another's receipt");
});

test("an undeclared effect fails closed where mutation is expected", async () => {
  // The shipped canonical dictionary declares `effect` on ZERO of its 43
  // primitives, so a guard firing only on an explicit "mutation" is inert on
  // the real artifact -- and my previous test proved a path the shipped
  // dictionary cannot take, by inventing a fixture that declares one.
  const dictionary = await readJson(canonicalUrl);
  assert.equal(
    dictionary.primitives.filter((p) => p.effect !== undefined).length,
    0,
    "this test's premise is that the shipped dictionary declares no effects",
  );

  const build = (ledger, preflight) => {
    const registry = new PrimitiveRegistry();
    const counter = { n: 0 };
    registry.register("text.insert", async () => {
      counter.n += 1;
      return { ok: true };
    });
    return {
      host: new EmbedHost({
        dictionary, registry, ledger, send: async () => {},
        hostState: {
          host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
          ...(preflight ? { preflight } : {}),
          // text.insert is embed-supported and side-effecting, and the shipped
          // dictionary declares no effect for it -- which is the case.
          namespaces: { text: { provider: "x", registrations: { x: { implements: ["text.insert"] } } } },
        },
      }),
      counter,
    };
  };

  // A host claiming durable custody and injecting no store is the case worth
  // failing closed on: it is a configuration that believes it can mutate.
  const claiming = build(null, "durable_mutation_store_ready");
  await claiming.host.handleActionCall({ call_id: "a", primitive: "text.insert", arguments: { text: "x" } });
  assert.equal(claiming.counter.n, 0, "an undeclared effect executed with no receipt custody");

  // Positive control: with a store it proceeds, so the guard is not simply
  // disabling the shipped dictionary.
  const stored = build(new (await import("../src/embed/embed-host.mjs")).DurableReceiptStore(), "durable_mutation_store_ready");
  await stored.host.handleActionCall({ call_id: "b", primitive: "text.insert", arguments: { text: "x" } });
  assert.equal(stored.counter.n, 1);
});

test("a handler failure settles terminally and replays as that failure", async () => {
  // Two findings in one sequence, because they compound. The failure was
  // delivered and never settled, so the row stayed reserved and the next
  // identical call waited on a live owner that would never finish -- and every
  // read path spread `receipt.result`, so a settled_error would have replayed
  // as `{from_receipt:true}` with no error at all.
  const { DurableReceiptStore } = await import("../src/embed/embed-host.mjs");
  const fixture = {
    kind: "canonical", version: 1, stage: 1,
    primitives: [{ name: "p.go", capability_class: "portable", portable: true, effect: "read_only" }],
  };
  const registry = new PrimitiveRegistry();
  let invocations = 0;
  registry.register("p.go", async () => {
    invocations += 1;
    throw new Error("handler blew up");
  });

  const sent = [];
  const host = new EmbedHost({
    dictionary: fixture, registry, ledger: new DurableReceiptStore(),
    send: async (item) => { sent.push(item.type); },
    hostState: {
      host: "embed", revision: "r", principal_id: "p",
      tenant_id: "t", installation_id: "i", authority_mode: "owner_rights",
      namespaces: { p: { provider: "x", registrations: { x: { implements: ["p.go"] } } } },
    },
  });

  const call = { call_id: "c-1", primitive: "p.go", arguments: {} };
  const first = await host.handleActionCall(call);
  assert.equal(first.error.code, "handler_failed");

  // Does not hang: the row is terminal, not reserved. A 150ms race is the
  // discriminator, since the old behaviour waited on a promise nobody settles.
  const second = await Promise.race([
    host.handleActionCall(call),
    new Promise((resolve) => setTimeout(() => resolve("HUNG"), 150)),
  ]);
  assert.notEqual(second, "HUNG", "an unsettled failure left the row reserved");

  // And replays as the FAILURE, not an empty success shape.
  assert.equal(second.type, "action_error");
  assert.equal(second.error.code, "handler_failed");
  assert.equal(second.from_receipt, true);

  assert.equal(invocations, 1, "the replay re-ran the handler");
  // Both crossings delivered an envelope: a reconstructed browser needs the
  // terminal result, not just the caller's return value.
  assert.deepEqual(sent, ["action_error", "action_error"]);
});

// --- The shipped dictionary, not a fixture built to suit -----------------
//
// Review weakness: the store and rejected-call tests run against fixtures that
// declare `effect: "mutation"`, and against the reference adapter. The shipped
// dictionary declares `effect` on 0 of its 43 primitives, so a guard written
// only for the declared path is inert in production while its test is green.
// These reconstruct a production EmbedHost over the real dictionary.

const shipped = JSON.parse(
  await readFile(new URL("../src/primitives/dictionary.v1.json", import.meta.url), "utf8"),
);

function productionHost({ ledger, hostState }) {
  const invocations = { count: 0 };
  const registry = new PrimitiveRegistry();
  for (const primitive of shipped.primitives) {
    registry.register(primitive.name, async () => {
      invocations.count += 1;
      return { ok: true };
    });
  }
  const host = new EmbedHost({
    dictionary: shipped, registry, ledger, hostState, send: async () => {},
  });
  return { host, invocations };
}

const grantAll = (namespace, primitives) => ({
  [namespace]: { provider: "x", registrations: { x: { implements: primitives } } },
});

test("the shipped dictionary declares no effect, so the undeclared path is the live one", () => {
  // This is the premise the two tests below depend on. If the dictionary ever
  // starts declaring `effect`, they stop testing what they were written for
  // and this fails rather than passing quietly.
  const declared = shipped.primitives.filter((p) => p.effect !== undefined);
  assert.deepEqual(
    declared.map((p) => p.name),
    [],
    "primitives now declare `effect` -- the undeclared-effect tests below need revisiting",
  );
});

test("a host claiming mutation custody with no store refuses a shipped primitive", async () => {
  // `preflight` set is the host claiming mutations happen here. With no
  // ledger, every undeclared-effect primitive must fail closed -- on the real
  // dictionary, where undeclared is ALL of them.
  const overlay = shipped.primitives.map((p) => p.name).filter((n) => n.startsWith("overlay."));
  assert.ok(overlay.length > 0, "no overlay primitives in the shipped dictionary");

  const { host, invocations } = productionHost({
    ledger: null,
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      preflight: "durable_mutation_store_ready",
      namespaces: grantAll("overlay", overlay),
    },
  });

  const result = await host.handleActionCall({ call_id: "c-1", name: overlay[0] });
  assert.equal(result.error.code, "capability_unavailable");
  assert.equal(result.error.reason, "durable_store_unavailable");
  assert.equal(result.error.remediation, "provision_receipt_store");
  assert.equal(invocations.count, 0, "the handler ran despite no durable store");
});

test("a host claiming no mutation custody still serves the same primitive", async () => {
  // The control. Without it, a host that refused everything would pass the
  // test above -- and a capability that is never available is not a guard, it
  // is an outage.
  const overlay = shipped.primitives.map((p) => p.name).filter((n) => n.startsWith("overlay."));
  const { host, invocations } = productionHost({
    ledger: null,
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      namespaces: grantAll("overlay", overlay),
    },
  });

  const result = await host.handleActionCall({ call_id: "c-1", name: overlay[0] });
  assert.equal(result.error, undefined, `refused with ${JSON.stringify(result.error)}`);
  assert.equal(invocations.count, 1, "the handler did not run");
});

test("a rejected call on the production host writes no receipt and does not wedge", async () => {
  // The reference adapter has this test; the production host did not. A
  // rejection that leaves an admitted row wedges the NEXT identical call,
  // which is a durable row on Snowflake rather than a process artifact.
  const overlay = shipped.primitives.map((p) => p.name).filter((n) => n.startsWith("overlay."));
  const ledger = new ReceiptLedger();
  const { host, invocations } = productionHost({
    ledger,
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      preflight: "durable_mutation_store_ready",
      namespaces: {}, // nothing granted: the call is unsupported
    },
  });

  const call = { call_id: "c-1", name: overlay[0] };
  const first = await host.handleActionCall({ ...call });
  assert.equal(first.error.code, "capability_unavailable");
  assert.equal(invocations.count, 0);

  // The identical next call must answer promptly rather than await a promise
  // nobody will settle.
  const second = await Promise.race([
    host.handleActionCall({ ...call }),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 100)),
  ]);
  assert.notEqual(second, "TIMEOUT", "the second identical rejected call wedged");
  assert.equal(second.error.code, "capability_unavailable");
  assert.equal(invocations.count, 0, "a rejected call executed a handler");
});

// --- #340's immutable snapshot and content identity, mirrored -------------
//
// The Python trusted boundary (contracts/capability-resolution/
// streamlit_trusted_host.py) freezes one provider snapshot per host, requires
// a sha256 CONTENT digest as provider identity, and derives an effective host
// revision binding the installation revision to what will actually run. The
// JS registry had none of the three.

test("a handler registered after construction does not reach the host", async () => {
  // The defect this closes, stated as a behaviour: before the snapshot, this
  // late registration EXECUTED on an already-built host, so the host's
  // advertised revision described a surface that could still change.
  const overlay = shipped.primitives.map((p) => p.name).filter((n) => n.startsWith("overlay."));
  assert.ok(overlay.length >= 2, "need two overlay primitives");

  const registry = new PrimitiveRegistry();
  registry.register(overlay[0], async () => ({ ok: true }));
  const host = new EmbedHost({
    dictionary: shipped, registry, ledger: new ReceiptLedger(), send: async () => {},
    hostState: {
      host: "embed", revision: "r", principal_id: "p", authority_mode: "owner_rights",
      namespaces: grantAll("overlay", overlay),
    },
  });

  registry.register(overlay[1], async () => ({ sneaked: true }));

  const late = await host.handleActionCall({ call_id: "c-1", name: overlay[1] });
  assert.ok(late.error, "a handler registered after construction reached the host");

  // Control: the snapshot is not simply empty. Without this, a host that
  // refused everything would pass the assertion above.
  const granted = await host.handleActionCall({ call_id: "c-2", name: overlay[0] });
  assert.equal(granted.error, undefined, `snapshot primitive refused: ${JSON.stringify(granted.error)}`);
});

test("a frozen snapshot refuses registration; its source stays mutable", () => {
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({}));
  const snapshot = registry.snapshot();

  assert.equal(snapshot.frozen, true);
  assert.throws(() => snapshot.register("overlay.close", async () => ({})), /frozen/);

  // The caller keeps its own registry. Freezing the source instead would make
  // one host's construction break the next.
  assert.equal(registry.frozen, false);
  registry.register("overlay.close", async () => ({}));
  assert.ok(registry.names().includes("overlay.close"));
  assert.ok(!snapshot.names().includes("overlay.close"), "the snapshot tracked its source");
});

test("provider identity is a content digest, not a name", () => {
  const registry = new PrimitiveRegistry();
  const digest = `sha256:${"a".repeat(64)}`;

  assert.throws(
    () => registry.register("a.one", async () => ({}), { provider: "p", providerRevision: "v2" }),
    /content digest/,
    "a version string was accepted as provider identity",
  );
  assert.throws(
    () => registry.register("a.one", async () => ({}), { provider: "p", providerRevision: `sha256:${"a".repeat(63)}` }),
    /content digest/,
    "a short digest was accepted",
  );

  registry.register("a.one", async () => ({}), { provider: "p", providerRevision: digest });
  // A name can be reused across incompatible implementations, so one provider
  // name claiming two contents is a conflict, not a re-registration.
  assert.throws(
    () => registry.register("a.two", async () => ({}), { provider: "p", providerRevision: `sha256:${"b".repeat(64)}` }),
    /different revision/,
  );
});

test("the fingerprint moves with membership and with provider content", () => {
  const digest = (c) => `sha256:${c.repeat(64)}`;
  const build = (members, revision) => {
    const registry = new PrimitiveRegistry();
    for (const member of members) {
      registry.register(member, async () => ({}), { provider: "p", providerRevision: revision });
    }
    return registry;
  };

  const base = build(["a.one"], digest("a")).fingerprint();
  assert.notEqual(base, build(["a.one", "a.two"], digest("a")).fingerprint(), "membership is not bound");
  assert.notEqual(base, build(["a.one"], digest("b")).fingerprint(), "provider content is not bound");
  assert.equal(base, build(["a.one"], digest("a")).fingerprint(), "the digest is not stable");

  const withDescriptor = new PrimitiveRegistry();
  withDescriptor.register("a.one", async () => ({}), {
    provider: "p",
    providerRevision: digest("a"),
    descriptor: { summary: "provider A" },
  });
  assert.notEqual(base, withDescriptor.fingerprint(), "provider descriptor is not bound");
});

test("the effective host revision binds the installation revision AND the providers", () => {
  const digest = (c) => `sha256:${c.repeat(64)}`;
  const registryWith = (revision) => {
    const registry = new PrimitiveRegistry();
    registry.register("a.one", async () => ({}), { provider: "p", providerRevision: revision });
    return registry;
  };

  const base = effectiveHostRevision("rev-1", registryWith(digest("a")));
  // An installation revision alone would leave these two equal, and a caller
  // comparing revisions would conclude two hosts running different code agree.
  assert.notEqual(base, effectiveHostRevision("rev-1", registryWith(digest("b"))));
  assert.notEqual(base, effectiveHostRevision("rev-2", registryWith(digest("a"))));
  assert.match(base, /^host-[0-9a-f]{32}$/);
});

test("the JS fingerprint agrees byte-for-byte with the Python boundary", () => {
  // Computed from streamlit_trusted_host.py's preimage, not from this
  // implementation: domain line, compact JSON separators, sorted keys and
  // sorted members. Two implementations of one contract that fingerprint
  // differently cannot check each other, which is what a content identity is
  // for. If this drifts, one of the two sides changed its preimage.
  const registry = new PrimitiveRegistry();
  registry.register("overlay.open", async () => ({}), {
    provider: "x", providerRevision: `sha256:${"a".repeat(64)}`,
  });

  assert.equal(
    registry.fingerprint(),
    "4c7f1bfc0de6db94f681fec2c8984e748896283296e770699a2215e5bb97b308",
  );
  assert.equal(effectiveHostRevision("rev-1", registry), "host-604e96e9135e69e84dc0ed0e81cc74f0");

  // A harder case: several providers, out-of-order insertion, Unicode keys
  // whose UTF-16 and UTF-8 order diverges, and a non-ASCII installation
  // revision. The expected value is independently reproduced in Python.
  const mixed = new PrimitiveRegistry();
  mixed.register("z.last", async () => ({}), {
    provider: "zeta",
    providerRevision: `sha256:${"b".repeat(64)}`,
    descriptor: {
      summary: "z",
      input_schema: { type: "object", properties: { "\ue000": { type: "string" }, "😀": { type: "string" } } },
    },
  });
  mixed.register("a.first", async () => ({}), { provider: "alpha", providerRevision: `sha256:${"c".repeat(64)}` });
  mixed.register("m.mid", async () => ({}), { provider: "alpha", providerRevision: `sha256:${"c".repeat(64)}` });

  assert.equal(
    mixed.fingerprint(),
    "c7158a5c9bc8295c947c870e1e928b30789a04caab4290842dc46d09b4ebbcf8",
  );
  assert.equal(effectiveHostRevision("rev-Ω", mixed), "host-d38f232f010d1405d53ddaa5a46d5a40");
});
