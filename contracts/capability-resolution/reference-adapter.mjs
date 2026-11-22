// A reference adapter: the minimum an implementation must provide, and the
// thing that makes the runner a gate rather than a library.
//
// The runner shipped on this branch with nothing importing it. It was dead
// code in the PR whose whole claim was that the corpus executes -- I reported
// "9 of 9 operations dispatched" about a branch that dispatched none of them,
// because the only test exercising it lived on the dependent branch. A runner
// nobody runs and a corpus nobody executes are indistinguishable from having
// neither.
//
// This adapter implements the contract directly from the vectors' own
// declared semantics, so the corpus is executable on this branch alone,
// without the resolver. It is deliberately simple: its job is to prove the
// runner dispatches and that every expectation is consumed, not to be a
// second implementation competing with the real one.

import { sha256Hex } from "../../runtime/actions-json-runtime/src/crypto/sha256.mjs";

const DIGEST_DOMAIN = "actions-json/request-digest/v1";

// Exactly the three states the spec defines. Anything else -- absent, a typo,
// a value from a newer host -- is not a state.
const PREFLIGHT_STATES = new Set([
  "durable_mutation_store_ready",
  "setup_required",
  "read_only_ready",
]);

/**
 * The canonical request digest.
 *
 * Previously `request_digest` was "any non-empty string", which made
 * same-id-different-payload undetectable across implementations: two runtimes
 * could each be self-consistent and disagree about whether a replay was a
 * replay. UTF-8 text rather than JSON, because serializer differences in key
 * order and number formatting are exactly the drift a cross-language digest
 * must not inherit.
 */
export function requestDigest({
  primitive,
  arguments: args = {},
  primitive_version = null,
} = {}) {
  // CALLER-STABLE identity only: primitive, arguments, and versioned contract
  // identity a caller can reproduce without resolving anything.
  //
  // Provider was here and had to come out. Binding it made replay depend on
  // LIVE resolution: after a provider is withdrawn the digest cannot be
  // reproduced, so a settled receipt became unreachable and a retry would
  // re-execute a mutation that already happened. What actually executed is
  // recorded separately as an execution_binding on the row -- an immutable
  // fact about the past, not an input to identifying the request.
  const preimage = [
    DIGEST_DOMAIN,
    primitive,
    primitive_version === null ? "-" : String(primitive_version),
    canonical(args),
  ].join("\n") + "\n";
  return `req-${sha256Hex(preimage).slice(0, 32)}`;
}

function catalogFingerprint(primitives) {
  const lines = primitives.map((p) => [
    p.primitive ?? "",
    p.support ?? "",
    p.reason ?? "",
    p.decided_by ?? "",
    p.descriptor == null ? "" : sha256Hex(canonical(p.descriptor)),
  ].join("\t")).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const material = `actions-json/catalog-fingerprint/v2\n${lines.map((line) => `${line}\n`).join("")}`;
  return `cat-${sha256Hex(material).slice(0, 32)}`;
}

export function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const MINIMUM_SCHEMA_KEYS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
const MAXIMUM_SCHEMA_KEYS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];
const EXACT_SCHEMA_KEYS = [
  "pattern", "format", "multipleOf", "uniqueItems", "$ref",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
];
const ANNOTATION_SCHEMA_KEYS = ["title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"];
const HANDLED_SCHEMA_KEYS = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  ...MINIMUM_SCHEMA_KEYS, ...MAXIMUM_SCHEMA_KEYS, ...EXACT_SCHEMA_KEYS, ...ANNOTATION_SCHEMA_KEYS,
]);
const DESCRIPTOR_AUTHORITIES = new Set(["same_as_primitive", "additional_policy"]);
const DESCRIPTOR_EFFECTS = new Set(["same_as_primitive", "read", "mutation"]);

function schemaNarrows(base, candidate) {
  if (canonical(base) === canonical(candidate)) return true;
  if (!base || !candidate || typeof base !== "object" || typeof candidate !== "object"
      || Array.isArray(base) || Array.isArray(candidate)) return false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(candidate)])) {
    if (!HANDLED_SCHEMA_KEYS.has(key)) return false;
  }
  if (base.type !== undefined && canonical(base.type) !== canonical(candidate.type)) return false;
  if (base.enum !== undefined) {
    if (!Array.isArray(candidate.enum) || candidate.enum.length === 0) return false;
    const allowed = new Set(base.enum.map(canonical));
    if (!candidate.enum.every((value) => allowed.has(canonical(value)))) return false;
  }
  if (base.const !== undefined && canonical(base.const) !== canonical(candidate.const)) return false;
  for (const key of MINIMUM_SCHEMA_KEYS) {
    if (base[key] !== undefined && (typeof candidate[key] !== "number" || candidate[key] < base[key])) return false;
  }
  for (const key of MAXIMUM_SCHEMA_KEYS) {
    if (base[key] !== undefined && (typeof candidate[key] !== "number" || candidate[key] > base[key])) return false;
  }
  for (const key of EXACT_SCHEMA_KEYS) {
    if (base[key] !== undefined && canonical(base[key]) !== canonical(candidate[key])) return false;
  }
  const required = new Set(candidate.required ?? []);
  for (const name of base.required ?? []) if (!required.has(name)) return false;
  const baseProperties = base.properties ?? {};
  const candidateProperties = candidate.properties ?? {};
  for (const [name, property] of Object.entries(candidateProperties)) {
    if (!Object.hasOwn(baseProperties, name) || !schemaNarrows(baseProperties[name], property)) return false;
  }
  for (const name of base.required ?? []) if (!Object.hasOwn(candidateProperties, name)) return false;
  if (base.additionalProperties === false && candidate.additionalProperties !== false) return false;
  if (base.additionalProperties && typeof base.additionalProperties === "object"
      && !schemaNarrows(base.additionalProperties, candidate.additionalProperties)) return false;
  if (base.items !== undefined && !schemaNarrows(base.items, candidate.items)) return false;
  return true;
}

function effectiveDescriptor(entry, registration, primitive) {
  const fallback = {
    summary: entry.summary ?? "",
    input_schema: entry.input_schema ?? { type: "object", properties: {}, additionalProperties: false },
    ...(entry.output_schema === undefined ? {} : { output_schema: entry.output_schema }),
    source: "dictionary",
    provider_extensions: {},
  };
  const overlay = registration?.descriptors?.[primitive];
  if (overlay === undefined) return fallback;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new Error("invalid_provider_descriptor");
  }
  const input = overlay.input_schema ?? fallback.input_schema;
  const canonicalProperties = fallback.input_schema.properties ?? {};
  const providerProperties = input.properties ?? {};
  const extensions = overlay.extensions?.input ?? {};
  for (const [name, schema] of Object.entries(providerProperties)) {
    if (Object.hasOwn(canonicalProperties, name)) {
      continue;
    }
    const declaration = extensions[name];
    if (!DESCRIPTOR_AUTHORITIES.has(declaration?.authority)
        || !DESCRIPTOR_EFFECTS.has(declaration?.effect)) {
      throw new Error("undeclared_provider_extension");
    }
  }
  for (const name of Object.keys(extensions)) {
    if (!Object.hasOwn(providerProperties, name) || Object.hasOwn(canonicalProperties, name)) {
      throw new Error("invalid_provider_extension");
    }
  }
  const canonicalWithExtensions = structuredClone(fallback.input_schema);
  canonicalWithExtensions.properties = {
    ...(canonicalWithExtensions.properties ?? {}),
    ...Object.fromEntries(Object.entries(providerProperties).filter(([name]) => !Object.hasOwn(canonicalProperties, name))),
  };
  if (!schemaNarrows(canonicalWithExtensions, input)) throw new Error("incompatible_provider_descriptor");
  if (overlay.output_schema !== undefined
      && (fallback.output_schema === undefined || canonical(overlay.output_schema) !== canonical(fallback.output_schema))) {
    throw new Error("incompatible_provider_descriptor");
  }
  return {
    summary: overlay.summary ?? fallback.summary,
    input_schema: input,
    ...(fallback.output_schema === undefined ? {} : { output_schema: fallback.output_schema }),
    source: "provider_registration",
    provider_extensions: extensions,
  };
}

/**
 * The authority key a receipt store must use.
 *
 * `authority_mode` is part of the key, not metadata beside it: the same call
 * under owner rights and under caller rights executes with different
 * privileges, so treating them as one call would let a receipt earned under
 * one authority answer a request made under the other.
 *
 * `installation_id` is stable identity, deliberately NOT `installation_revision`
 * -- keying on the revision would make every unrelated config change
 * invalidate outstanding calls, which is the wedge the contract forbids.
 */
export function authorityKey(scope = {}) {
  // runtime_id is deliberately ABSENT. A process, component instance,
  // WebSocket, script run or reconstructed host may all rotate while viewer
  // continuity remains valid, so keeping that volatile identity in the key
  // turned every reconstruction into a miss -- silently, with every test
  // passing, because a test that builds both instances with the same id
  // cannot see it. It survives as bounded diagnostics, never as authority.
  //
  // authority_mode IS in the binding: an owner-rights token presented in
  // caller-rights mode must not resume owner-rights receipts, and the correct
  // outcome is that the token is simply unknown inside the caller-rights
  // binding rather than downgraded, upgraded, or replayed across modes.
  return JSON.stringify([
    scope.installation_id ?? null,
    scope.tenant_id ?? null,
    scope.principal_id ?? null,
    scope.continuation_id ?? scope.session_id ?? null,
    scope.authority_mode ?? "unspecified",
  ]);
}

/**
 * Admit a continuation token, per the #337 binding ruling.
 *
 * The browser-carried token is an untrusted lookup HINT, never an authority
 * identifier the browser gets to mint. Authority is derived from trusted host
 * state first; the token is then resolved only INSIDE that binding.
 *
 * An unknown token is treated exactly like no token: a fresh server-minted
 * scope. Not "look it up globally, then refuse on principal mismatch" -- that
 * is an existence oracle, and it discloses by timing whatever the response
 * says. A token belonging to another principal is therefore observationally
 * identical to a random one.
 */
export function admitContinuation({ trusted, presented, store }) {
  if (presented !== undefined && presented !== null) {
    if (typeof presented !== "string" || presented.length === 0 || presented.length > 128) {
      return { outcome: "error", reason: "invalid_arguments" };
    }
  }

  // A claimed identity that disagrees with the authenticated one is refused
  // before any continuation lookup. principal_mismatch is for an explicit
  // conflicting claim, never for classifying an opaque token.
  if (trusted.claimed_principal_id && trusted.claimed_principal_id !== trusted.principal_id) {
    return { outcome: "error", reason: "principal_mismatch" };
  }

  const binding = {
    tenant_id: trusted.tenant_id,
    installation_id: trusted.installation_id,
    principal_id: trusted.principal_id,
    authority_mode: trusted.authority_mode,
  };

  if (presented && store?.hasScope?.(authorityKey({ ...binding, continuation_id: presented }))) {
    return { outcome: "ok", continuity: "resumed", continuation_id: presented };
  }

  // Unknown, or belonging to another binding: mint a fresh one. The caller's
  // value is never adopted.
  const minted = `cont-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  return { outcome: "ok", continuity: "created", continuation_id: minted };
}

/**
 * A DURABLE store, injected — the thing a host does not own.
 *
 * The previous `ReferenceStore.reconstruct()` returned `this`, with a
 * docstring claiming it destroyed in-process state. So the reconstruction test
 * reused the same object and the same private Map, and would have passed with
 * the reconstruction it claimed to prove entirely absent: a test asserting its
 * own comment.
 *
 * A real Streamlit V1 rerun destroys the Python host instance. Whatever
 * survives has to live outside it, which is why this is passed IN rather than
 * constructed by the host. `st.session_state` cannot play this role — it
 * resets with the WebSocket — so in the warehouse projection this is a
 * Snowflake table.
 */
export class DurableReceiptStore {
  #rows = new Map();
  #continuations = new Map();
  #leaseMs;
  #now;

  /**
   * @param leaseMs   how long an acquisition holds the row before it is
   *                  classified as an unresolved disposition.
   * @param now       injectable clock, so lease expiry is testable without
   *                  sleeping.
   */
  constructor({ leaseMs = 30_000, now = () => Date.now() } = {}) {
    this.#leaseMs = leaseMs;
    this.#now = now;
  }

  /**
   * NON-MUTATING read. Detects conflict/terminal/in-flight/unknown without
   * admitting anything.
   *
   * Lookup and admission were one operation, so a call that was about to be
   * REJECTED still wrote a live reservation -- and the next identical request
   * awaited it forever. A rejected call must leave no admitted state, and on
   * Snowflake that row would be durable rather than process-local.
   */
  inspect(key, callId, digest) {
    const row = this.#rows.get(`${key}::${callId}`);
    if (!row) return { state: "absent" };
    if (row.digest !== digest) return { state: "conflict" };
    if (row.state === "settled_success") {
      return { state: "settled", receipt: { state: "settled_success", result: row.result, execution_binding: row.execution_binding ?? null } };
    }
    if (row.state === "settled_error") {
      return { state: "settled", receipt: { state: "settled_error", error: row.error, execution_binding: row.execution_binding ?? null } };
    }
    if (this.#ownerIsLive(row)) {
      return { state: "in_flight", owner_token: row.owner_token, settled: row.settled_promise ?? null };
    }
    return { state: "unknown_disposition" };
  }

  /** Atomic reserve-if-absent. Never a read followed by a write. */
  reserve(key, callId, digest, executionBinding = null) {
    // execution_binding is accepted AT ADMISSION, not only at settle.
    // The Snowflake adapter writes one row under an enforced composite
    // primary key, so whatever the row must carry has to be present at INSERT
    // -- a binding supplied later would need a second write and reopen the
    // window this design closes. The reference store took it only at settle,
    // which worked for an in-memory Map and would not have survived contact
    // with the real backend.
    const id = `${key}::${callId}`;
    const row = this.#rows.get(id);

    if (!row) {
      // Acquisition issues an owner token. "The row is reserved" is not
      // enough for compare-and-set: any worker holding only (key, call_id)
      // could otherwise settle it, including a stale one after another
      // recovery path has taken responsibility.
      const ownerToken = `own-${Math.random().toString(36).slice(2, 10)}`;
      let announce;
      const settledPromise = new Promise((resolve) => {
        announce = resolve;
      });
      this.#rows.set(id, {
        state: "reserved", digest, owner_token: ownerToken,
        execution_binding: executionBinding,
        owner_live: true, reserved_at: this.#now(), result: null, error: null,
        settled_promise: settledPromise, announce,
      });
      return { state: "acquired", owner_token: ownerToken };
    }
    if (row.digest !== digest) return { state: "conflict" };
    if (row.state === "settled_success") {
      return { state: "settled", receipt: { state: "settled_success", result: row.result, execution_binding: row.execution_binding ?? null } };
    }
    if (row.state === "settled_error") {
      return { state: "settled", receipt: { state: "settled_error", error: row.error, execution_binding: row.execution_binding ?? null } };
    }

    // A LIVE owner and a LOST one are different states, and conflating them
    // was wrong in the dangerous direction for one and the useless direction
    // for the other. A concurrent same-digest caller should coalesce and
    // receive the same terminal receipt; only ownership loss is a disposition
    // nobody can establish.
    if (this.#ownerIsLive(row)) {
      // A waiter needs somewhere to wait. Returning the state without a way to
      // await it is what let the caller fall through and execute anyway.
      return { state: "in_flight", owner_token: row.owner_token, settled: row.settled_promise ?? null };
    }
    return { state: "unknown_disposition" };
  }

  /**
   * Compare-and-set to a terminal state. Only a reserved row may settle, and
   * only once: an unconditional overwrite would let a late writer clobber a
   * settled receipt with a stale one.
   */
  settle(key, callId, { result = null, error = null, owner_token: ownerToken, digest } = {}) {
    const id = `${key}::${callId}`;
    const row = this.#rows.get(id);
    if (!row) return { ok: false, reason: "no_reservation" };
    if (row.state !== "reserved") return { ok: false, reason: "already_terminal" };
    // Terminal transitions condition on the SAME key, digest, reserved state
    // AND owner token. A stale worker returning after recovery holds the first
    // three; the token is what distinguishes it.
    if (ownerToken !== row.owner_token) return { ok: false, reason: "wrong_owner" };
    // Mandatory. The optional branch let the rightful owner settle without
    // proving WHICH request it was settling, so the agreed condition -- key +
    // reserved state + owner token + digest -- was only three of four.
    if (digest === undefined) return { ok: false, reason: "missing_digest" };
    if (digest !== row.digest) return { ok: false, reason: "wrong_digest" };

    const state = error ? "settled_error" : "settled_success";
    // execution_binding is an immutable record of what actually ran. It is
    // NOT part of request identity: a caller must be able to identify its own
    // request without knowing which provider served it.
    // The admission binding is IMMUTABLE. settle changes state, result and
    // error -- never the record of what executed.
    //
    // The previous `binding ?? row.execution_binding` let a worker replace the
    // provider, version or effect identity after admission, so the audit
    // record could be rewritten by whoever settled. The Snowflake adapter's
    // conditional UPDATE deliberately never touches EXECUTION_BINDING_JSON,
    // and this is that contract rather than a looser one that happens to
    // agree in the common case.
    this.#rows.set(id, {
      ...row, state, result, error, owner_live: false,
      execution_binding: row.execution_binding ?? null,
    });
    // Release anyone coalescing behind this owner.
    row.announce?.({ state, result, error });
    return { ok: true, state };
  }

  /**
   * Remember which server-minted scope a presented token was admitted into.
   *
   * DURABLE, not per-host: a reconstructed host must reach the same scope, or
   * every rerun mints a new one and replay is impossible. Keyed by the trusted
   * binding plus the presented value, so a token presented under a different
   * principal cannot reach another's mapping.
   */
  rememberContinuation(bindingKey, presented, minted) {
    this.#continuations ??= new Map();
    const id = `${bindingKey}::${presented ?? ""}`;
    if (!this.#continuations.has(id)) this.#continuations.set(id, minted);
    return this.#continuations.get(id);
  }

  recallContinuation(bindingKey, presented) {
    return this.#continuations?.get(`${bindingKey}::${presented ?? ""}`) ?? null;
  }

  /** Does this authority binding have any rows? Used only inside an already
   *  derived binding, never as a global token probe. */
  hasScope(key) {
    for (const id of this.#rows.keys()) if (id.startsWith(`${key}::`)) return true;
    return false;
  }

  /**
   * Liveness by LEASE, matching the Snowflake adapter's server-time
   * classification rather than a boolean nobody is left to flip.
   *
   * `owner_live` alone meant a crashed owner stayed in_flight forever: the
   * process that would have called loseOwner is the one that died, so every
   * later caller coalesced behind a promise nobody would settle. A durable
   * store cannot depend on its client to announce its own death.
   */
  #ownerIsLive(row) {
    if (row.owner_live === false) return false;
    if (row.reserved_at === undefined || row.reserved_at === null) return true;
    return this.#now() - row.reserved_at < this.#leaseMs;
  }

  /** Mark an owner lost explicitly: a clean handover, not the crash path. */
  loseOwner(key, callId) {
    const id = `${key}::${callId}`;
    const row = this.#rows.get(id);
    if (row) this.#rows.set(id, { ...row, owner_live: false });
  }

  /** Rows survive a host; this is what "durable" means here. */
  snapshot() {
    return { rows: new Map(this.#rows), continuations: new Map(this.#continuations) };
  }

  static from(snapshot) {
    const store = new DurableReceiptStore();
    // Accept either shape: a bare row map from an older caller, or the full
    // snapshot including continuation mappings.
    const rows = snapshot instanceof Map ? snapshot : snapshot.rows;
    for (const [id, minted] of (snapshot instanceof Map ? [] : snapshot.continuations ?? [])) {
      store.#continuations.set(id, minted);
    }
    for (const [id, row] of rows) {
      // Reconstruction kills every in-process owner: the worker that held the
      // token no longer exists, so a reserved row becomes an unresolved
      // disposition rather than something to wait behind.
      store.#rows.set(id, { ...row, owner_live: false });
    }
    return store;
  }
}

/**
 * Build a reference adapter over a dictionary-shaped fixture.
 *
 * Resolution here follows the contract's precedence directly rather than
 * calling the real resolver, so this branch can execute the corpus without
 * depending on the implementation branch.
 */
export function referenceAdapter({ dictionary, store = new DurableReceiptStore() }) {
  // Caller-reproducible: read from the dictionary, never from live resolution.
  const dictionaryVersionOf = (name) =>
    (dictionary.primitives ?? []).find((p) => p.name === name)?.version ?? null;

  const resolve = ({ hostState, primitive, callContext = {}, dictionary: dictionaryOverride }) => {
    // A vector may supply its own dictionary when it tests a namespace the
    // canonical one does not yet define.
    const dict = dictionaryOverride ?? dictionary;
    const entry = (dict.primitives ?? []).find((p) => p.name === primitive);
    const namespace = primitive.includes(".") ? primitive.split(".")[0] : primitive;
    let descriptor = entry ? effectiveDescriptor(entry, null, primitive) : null;
    const fail = (reason, decided_by, remediation) => ({
      primitive, support: "unsupported", reason, decided_by, remediation,
      namespace, provider: null, descriptor,
    });

    if (!entry) return fail("primitive_not_found", "dictionary", "fix_request");
    if (!["extension", "embed", "bookmarklet"].includes(hostState?.host)) {
      return fail("host_unknown", "host_state", "fix_request");
    }

    const ns = hostState?.namespaces?.[namespace];
    if (!ns) return fail("namespace_unavailable", "host_state", "activate_provider");

    const provider = ns.provider ?? ns.selected ?? null;
    if (!provider && (ns.candidates ?? []).length > 1) {
      return fail("provider_conflict", "host_state", "fix_request");
    }
    if (!provider) return fail("namespace_unavailable", "host_state", "activate_provider");

    const registration = ns.registrations?.[provider];
    // Array.isArray, not just `.includes`. A bare STRING has `.includes` too,
    // so `implements: "data.write"` passed membership by substring match --
    // and a broader string like "data.write_all" would have granted
    // "data.write" as well. Duck-typing a membership list is a fail-open.
    const membership = registration?.implements;
    const registers = registration?.implements_namespace === true
      || (Array.isArray(membership) && membership.includes(primitive));
    if (!registers) return fail("capability_unavailable", "provider_registration", "none");
    descriptor = effectiveDescriptor(entry, registration, primitive);

    if (ns.health && ns.health !== "available") {
      return fail("provider_unavailable", "host_state", "retry_later");
    }

    // Preflight gates primitives whose EFFECT is a mutation. Effect comes from
    // the canonical primitive contract, never a hardcoded name list: a
    // provider can register `data.delete` or `table.insert` and bypass a name
    // list entirely, while `data.execute` may be read-only under some provider
    // contracts. The name is not the semantics.
    // An UNDECLARED effect is not "read_only" -- treating silence as harmless
    // let a mutation resolve supported with no durable store behind it.
    //
    // Scoped to documents that declare effect at all: the shipped canonical
    // dictionary predates the field, and failing every one of its primitives
    // closed would be a migration break rather than a safety gain. A document
    // that declares effect ANYWHERE must declare it everywhere, which is the
    // property that actually prevents a silent omission.
    const documentDeclaresEffect = (dict.primitives ?? []).some((p) => p.effect !== undefined);
    if (documentDeclaresEffect && entry.effect === undefined) {
      return fail("capability_unavailable", "dictionary", "fix_request");
    }
    // Rung 1 of the evidence ladder: TRANSPORT. This gates every primitive,
    // not only mutations.
    //
    // I had reasoned that a proposed projection could still carry reads. That
    // was wrong, and wrong in the familiar direction: the unproven thing is the
    // component return channel ITSELF. Snowflake proves static HTML/iframe
    // rendering for warehouse; it does not prove an embedded agent can send any
    // primitive call frontend-to-Python and receive its result across reruns.
    // A read advertised over a transport that may not exist is as false as a
    // mutation -- "reads are harmless" is about the primitive's effect, and the
    // missing evidence is about whether a call can happen at all.
    if (hostState?.projection !== undefined) {
      const transport = hostState?.transport_status;
      // Absent or unrecognised is not evidence. The previous version blocked
      // only an explicit "proposed", so a descriptor omitting the field
      // enabled everything -- the safety property depended on every producer
      // remembering a newly optional field.
      if (transport !== "supported") {
        return fail("capability_unavailable", "host_state", "none");
      }
    }

    if (entry.effect === "mutation") {
      // Rung 2: durable receipt custody, which narrows mutations further.
      const preflight = hostState?.preflight;

      // Absent or unrecognised is NOT a state. Previously the gate ran only
      // when `preflight` was truthy and matched one of two strings, so an
      // omitted value -- or the plausible typo `read_only` for
      // `read_only_ready` -- silently granted mutation authority.
      if (!PREFLIGHT_STATES.has(preflight)) {
        return fail("durable_store_unavailable", "host_state", "provision_receipt_store");
      }
      if (preflight === "setup_required") {
        // Names the layer that is actually missing. Reporting
        // namespace_unavailable / activate_provider was a lie: the provider IS
        // active and implements the primitive, and activating it again cannot
        // create the receipt table.
        return fail("durable_store_unavailable", "host_state", "provision_receipt_store");
      }
      if (preflight === "read_only_ready") {
        // A legitimate deployment, not a provider-registration failure, and
        // not fixable by the reader.
        return fail("capability_unavailable", "host_state", "none");
      }
    }

    const override = hostState.compatibility_profile === "dictionary_adapters"
      ? entry.adapters?.[hostState.host]
      : null;
    if (override?.support === "unsupported") {
      return fail("capability_unavailable", "compatibility_override", "none");
    }
    if (callContext.principal_id && hostState.principal_id
        && callContext.principal_id !== hostState.principal_id) {
      return fail("principal_mismatch", "call_context", "fix_request");
    }
    if ((callContext.site_policy_blocks ?? []).includes(primitive)) {
      return fail("capability_unavailable", "call_context", "none");
    }

    return {
      primitive, support: "supported", reason: null, remediation: "none",
      decided_by: "provider_registration", namespace, provider,
      primitive_version: entry.version ?? null,
      descriptor,
    };
  };

  const catalog = ({ hostState, callContext, dictionary: inline }) => {
    // A catalog vector may carry its own dictionary for the same reason a
    // resolve vector may: it exercises a namespace the shipped dictionary does
    // not define. Ignoring it resolves the wrong catalog, silently.
    const source = inline ?? dictionary;
    const primitives = (source.primitives ?? []).map((entry) =>
      resolve({ hostState, primitive: entry.name, callContext, dictionary: inline }),
    );
    return {
      host: hostState?.host ?? null,
      installation_revision: hostState?.revision ?? null,
      catalog_fingerprint: catalogFingerprint(primitives),
      primitives,
    };
  };

  const parse = (input) => {
    const doc = input.document_inline;
    if (!doc) return { outcome: "ok", reason: null };
    const flat = (doc.primitives ?? []).filter((p) => typeof p.support === "string");
    if (doc.kind === "canonical" && flat.length > 0) {
      return { outcome: "error", reason: "canonical_document_carries_flat_support" };
    }
    for (const primitive of doc.primitives ?? []) {
      for (const adapterEntry of Object.values(primitive.adapters ?? {})) {
        if (adapterEntry?.support && !["supported", "unsupported"].includes(adapterEntry.support)) {
          return { outcome: "error", reason: "invalid_support_value" };
        }
      }
    }
    if (doc.kind !== "canonical" && flat.length > 0 && !doc.host) {
      return { outcome: "error", reason: "host_undeclared" };
    }
    return { outcome: "ok", reason: null };
  };

  const formatCatalog = (input) => {
    const resolved = input.resolved_catalog;
    if (input.format_as_host && resolved?.host && resolved.host !== input.format_as_host) {
      return { outcome: "error", reason: "host_mismatch" };
    }
    return { outcome: "ok", reason: null };
  };

  const validateHostDescriptor = ({ projection, authority_mode } = {}) => {
    const modes = {
      "served-web": ["owner_rights", "caller_rights", "unspecified"],
      "streamlit-container-v2": ["owner_rights", "caller_rights", "unspecified"],
      // Warehouse runs owner rights; restricted caller rights are container
      // only, so a warehouse descriptor claiming them fails closed rather than
      // being downgraded.
      "streamlit-warehouse-v1": ["owner_rights", "unspecified"],
    }[projection];
    if (!modes) return { outcome: "error", reason: "unknown_projection" };
    if (authority_mode && !modes.includes(authority_mode)) {
      return { outcome: "error", reason: "authority_mode_unavailable_for_projection" };
    }
    return { outcome: "ok", reason: null };
  };

  const FORBIDDEN = new Set([
    "config_ref", "connection_identifier", "credential", "credentials",
    "secret_name", "account_locator", "password", "token",
  ]);

  const redact = (node) => {
    if (Array.isArray(node)) return node.map(redact);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN.has(key)) continue;
      out[key] = key === "provider" && typeof value === "string"
        ? `provider-${sha256Hex(value).slice(0, 8)}`
        : redact(value);
    }
    return out;
  };

  const providerIsOpaque = (snapshot) => {
    const names = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "provider" && typeof value === "string") names.push(value);
        else walk(value);
      }
    };
    walk(snapshot);
    return names.length > 0 && names.every((n) => n.startsWith("provider-"));
  };

  const runCalls = async (input) => {
    const results = [];
    let handlerInvocations = 0;
    const hostState = JSON.parse(JSON.stringify(input.host_state ?? {}));

    for (const [index, call] of (input.calls ?? []).entries()) {
      const scope = { ...(input.scope ?? {}), ...(call.scope ?? {}) };

      // The digest is computed WITHOUT resolving a provider, so a settled
      // receipt stays reachable after the provider that served it is
      // withdrawn. Resolving first made replay depend on live capability
      // state: the digest could not be reproduced, the receipt became
      // unreachable, and a retry would re-execute a mutation that had already
      // happened. A configuration change must not erase a settled fact.
      const digest = requestDigest({
        ...call,
        primitive_version: dictionaryVersionOf(call.primitive),
      });

      // Principal binding is checked at the STORE boundary, before execution
      // and before any receipt lookup -- not folded into capability
      // resolution. A cross-principal attempt is a distinct diagnosis from an
      // unavailable capability, and answering it with the latter would tell a
      // caller to go configure a provider when the real answer is that this
      // authority is not theirs. It also must not disclose whether the call id
      // exists.
      if (scope.principal_id && hostState.principal_id
          && scope.principal_id !== hostState.principal_id) {
        results.push({
          type: "action_error",
          error: { code: "principal_mismatch" },
          executed: false,
          from_receipt: false,
        });
        continue;
      }

      // INSPECT first -- a non-mutating read. Lookup and admission were one
      // operation, so a call about to be rejected still wrote a live
      // reservation and wedged the next identical request forever. A rejected
      // call must leave no admitted state.
      const key = authorityKey(scope);
      const seen = store.inspect
        ? store.inspect(key, call.call_id, digest)
        : { state: "absent" };

      if (seen.state === "settled") {
        // A terminal receipt is an immutable fact: returned without any live
        // resolution. The capability diagnostic is computed AFTER identifying
        // it and is non-authoritative -- a resolver failure must never
        // suppress a receipt that already exists.
        let diagnostic = null;
        try {
          const now = resolve({ hostState, primitive: call.primitive });
          diagnostic = { support: now.support, reason: now.reason, provider: now.provider ?? null };
        } catch {
          diagnostic = { support: "unknown", reason: "diagnostic_unavailable", provider: null };
        }
        results.push({
          ...(seen.receipt.result ?? {}),
          executed: false,
          from_receipt: true,
          execution_binding: seen.receipt.execution_binding ?? null,
          current_capability: diagnostic,
        });
        continue;
      }
      if (seen.state === "conflict") {
        results.push({ type: "action_error", error: { code: "call_id_conflict" }, executed: false, from_receipt: false });
        continue;
      }
      if (seen.state === "in_flight") {
        const terminal = seen.settled ? await seen.settled : null;
        results.push(terminal && terminal.state === "settled_success"
          ? { ...(terminal.result ?? {}), executed: false, from_receipt: true }
          : { type: "action_error", error: { code: "reconcile_required", reason: "owner_in_flight_unreachable" }, executed: false, from_receipt: false });
        continue;
      }
      if (seen.state === "unknown_disposition") {
        results.push({ type: "action_error", error: { code: "unknown_disposition" }, executed: false, from_receipt: false });
        continue;
      }
      if (seen.state !== "absent") {
        results.push({ type: "action_error", error: { code: "reconcile_required", reason: "unrecognised_store_state" }, executed: false, from_receipt: false });
        continue;
      }

      // Only an ACTUALLY ABSENT row reaches live resolution, because only then
      // might something execute.
      const decision = resolve({ hostState, primitive: call.primitive });
      if (decision.support !== "supported") {
        // Returns with NO durable write.
        results.push({ type: "action_error", error: { code: "capability_unavailable", reason: decision.reason }, executed: false, from_receipt: false });
        continue;
      }

      // Now admit, atomically. Another host may have won between inspect and
      // reserve, so every outcome is handled as if it had.
      const binding = {
        provider: decision.provider ?? null,
        primitive_version: decision.primitive_version ?? null,
        effect: decision.effect ?? null,
      };
      const priorClaim = store.reserve(key, call.call_id, digest, binding);
      if (priorClaim.state === "settled") {
        results.push({ ...(priorClaim.receipt.result ?? {}), executed: false, from_receipt: true });
        continue;
      }
      if (priorClaim.state === "conflict") {
        results.push({ type: "action_error", error: { code: "call_id_conflict" }, executed: false, from_receipt: false });
        continue;
      }
      if (priorClaim.state === "in_flight") {
        const terminal = priorClaim.settled ? await priorClaim.settled : null;
        results.push(terminal && terminal.state === "settled_success"
          ? { ...(terminal.result ?? {}), executed: false, from_receipt: true }
          : { type: "action_error", error: { code: "reconcile_required", reason: "owner_in_flight_unreachable" }, executed: false, from_receipt: false });
        continue;
      }
      if (priorClaim.state !== "acquired") {
        results.push({ type: "action_error", error: { code: "reconcile_required", reason: priorClaim.state === "unknown_disposition" ? "unknown_disposition" : "unrecognised_store_state" }, executed: false, from_receipt: false });
        continue;
      }

      handlerInvocations += 1;
      const receipt = { type: "action_call_output", output: { ok: true }, from_receipt: false };
      const written = store.settle(key, call.call_id, {
        result: receipt,
        owner_token: priorClaim.owner_token,
        digest,
      });

      results.push(written.ok
        ? { ...receipt, executed: true }
        : { type: "action_error", error: { code: "reconcile_required", reason: written.reason }, executed: true, from_receipt: false });

      for (const mutation of (input.mutations ?? []).filter((m) => m.after_call === index)) {
        if (mutation.withdraw_namespace) delete hostState.namespaces[mutation.withdraw_namespace];
        if (mutation.new_revision) hostState.revision = mutation.new_revision;
      }
    }
    return { results, handlerInvocations };
  };

  const runConcurrent = async (input) => {
    // Through the receipt store and the authority key, not a local Map. A
    // local Map proves the test coalesces, which is not the claim -- the claim
    // is that the STORE does, under the same key a real host would use.
    const scope = input.scope ?? {};
    const key = authorityKey(scope);
    let handlerInvocations = 0;

    // Same discipline as runCalls, which this path did not have: it resolved,
    // DISCARDED the verdict, and executed regardless -- so an unsupported call
    // both ran and wrote a row. I fixed one caller and left the other, which
    // is the shape of the last three defects here.
    const staged = (input.concurrent ?? []).map((call) => {
      const digest = requestDigest({
        ...call,
        primitive_version: dictionaryVersionOf(call.primitive),
      });

      // Non-mutating read first.
      const seen = store.inspect ? store.inspect(key, call.call_id, digest) : { state: "absent" };
      if (seen.state === "settled") {
        // Both callers observe the SAME terminal result; marking one a replay
        // would make two views of one execution look like two.
        return { ...(seen.receipt.result ?? {}) };
      }
      if (seen.state === "conflict") return { type: "action_error", error: { code: "call_id_conflict" } };
      if (seen.state === "in_flight") return { __await: seen.settled };
      if (seen.state === "unknown_disposition") return { type: "action_error", error: { code: "unknown_disposition" } };
      if (seen.state !== "absent") {
        return { type: "action_error", error: { code: "reconcile_required", reason: "unrecognised_store_state" } };
      }

      // Only an absent row reaches resolution, and an unsupported verdict
      // returns before anything is written.
      const decision = resolve({ hostState: input.host_state, primitive: call.primitive });
      if (decision.support !== "supported") {
        return { type: "action_error", error: { code: "capability_unavailable", reason: decision.reason } };
      }

      const binding = {
        provider: decision.provider ?? null,
        primitive_version: decision.primitive_version ?? null,
        effect: decision.effect ?? null,
      };
      const claim = store.reserve(key, call.call_id, digest, binding);
      if (claim.state === "settled") return { ...(claim.receipt.result ?? {}) };
      if (claim.state === "conflict") return { type: "action_error", error: { code: "call_id_conflict" } };
      if (claim.state === "in_flight") return { __await: claim.settled };
      if (claim.state !== "acquired") {
        return {
          type: "action_error",
          error: {
            code: claim.state === "unknown_disposition" ? "unknown_disposition" : "reconcile_required",
            reason: claim.state === "unknown_disposition" ? undefined : "unrecognised_store_state",
          },
        };
      }

      handlerInvocations += 1;
      const receipt = { type: "action_call_output", output: { ok: true } };
      const written = store.settle(key, call.call_id, {
        result: receipt,
        owner_token: claim.owner_token,
        digest,
      });
      if (!written.ok) {
        return { type: "action_error", error: { code: "reconcile_required", reason: written.reason } };
      }
      return receipt;
    });

    // Resolve anyone that coalesced behind a live owner, so both callers
    // observe the SAME terminal receipt.
    const results = await Promise.all(
      staged.map(async (entry) => {
        if (!entry?.__await) return entry;
        const terminal = await entry.__await;
        return terminal.state === "settled_success"
          ? { ...(terminal.result ?? {}), from_receipt: true }
          : { type: "action_error", error: terminal.error, from_receipt: true };
      }),
    );
    return { results, handlerInvocations };
  };

  return {
    resolve, catalog, parse, formatCatalog, validateHostDescriptor,
    redact, providerIsOpaque, runCalls, runConcurrent,
    store, requestDigest, authorityKey,
  };
}
