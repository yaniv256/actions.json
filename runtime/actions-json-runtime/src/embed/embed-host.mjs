// A served embed host: an actions.json runtime for a page that embeds an
// agent, rather than an extension driving a page it did not author.
//
// This exists so the host abstraction can be checked rather than asserted. A
// second host is the only thing that proves the first one generalised, and a
// specification with nothing running behind it cannot be checked at all.
//
// Two departures from the extension runtime, both deliberate:
//
//   1. Handlers are ADDRESSABLE BY NAME. The extension dispatches through two
//      hand-written if/else chains -- 64 branches in the content script and a
//      second set in the worker, split on a hardcoded privilege list. That
//      shape has already shipped a defect: `corpus.search` was advertised,
//      packaged, and green on every test, then answered `handler_failed` on
//      the first real call, because it was implemented on one of the two
//      paths. A registry cannot express that state: registration and
//      advertisement read from the same map.
//
//   2. Capability comes from the RESOLVER, never from a hardcoded list. The
//      extension's Rust projection gates on `extension_executor_supports_
//      primitive`, an allowlist whose host appears only in the function's
//      name. This host asks the resolver and refuses what it is not granted.
//
// What this module does NOT contain: any transport. A Streamlit component, a
// served page, and a test harness all carry these envelopes differently, and
// baking one in would make the runtime a Streamlit runtime. The host takes a
// `send` function and receives via `handleItem`.

import { sha256Hex } from "../crypto/sha256.mjs";

import {
  REASON,
  assertResolvedCatalogForHost,
  redactSnapshot,
  resolveCapability,
  resolveCatalog,
  validateDescriptorInput,
} from "../primitives/capability-resolver.mjs";
import {
  DurableReceiptStore,
  admitContinuation,
  authorityKey,
  requestDigest,
} from "../../../../contracts/capability-resolution/reference-adapter.mjs";

export class PrimitiveRegistry {
  #handlers = new Map();
  #descriptors = new Map();
  #providerRevisions = new Map();
  #frozen = false;

  /**
   * Register the implementation of one primitive.
   *
   * The registry is the single source of BOTH what runs and what is
   * advertised, which is the property that makes the corpus.search failure
   * unrepresentable: a primitive cannot be advertised here without a handler,
   * because the advertisement is derived from the handler map.
   */
  register(name, handler, { provider = null, providerRevision = null, descriptor = null } = {}) {
    // #340's rule, mirrored: a frozen snapshot refuses registration. Without
    // this, a handler registered AFTER a host was constructed executed on that
    // host -- verified -- so the host's capability surface was mutable behind
    // its back and its revision said nothing about what it would run.
    if (this.#frozen) {
      throw new Error("provider registry snapshot is frozen");
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("primitive name must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new TypeError(`handler for ${name} must be a function`);
    }
    // Provider identity is CONTENT, not a name: a name can be reused across
    // incompatible implementations, so binding a revision to a name binds
    // nothing. Matches the Python boundary's `^sha256:[0-9a-f]{64}$`.
    if (providerRevision !== null && !PROVIDER_REVISION.test(providerRevision)) {
      throw new TypeError("provider revision must be a sha256 content digest");
    }
    if (provider && providerRevision) {
      const known = this.#providerRevisions.get(provider);
      if (known && known !== providerRevision) {
        throw new Error(`provider ${provider} is already registered at a different revision`);
      }
      this.#providerRevisions.set(provider, providerRevision);
    }
    if (this.#handlers.has(PrimitiveRegistry.key(name, provider))) {
      throw new Error(
        `handler for ${name}${provider ? ` @ ${provider}` : ""} is already registered`,
      );
    }
    // Keyed by primitive AND provider. Keyed by primitive alone, the provider
    // resolution selected and the handler that actually ran were unrelated:
    // two providers registering the same primitive would have one of them
    // silently execute the other's implementation.
    //
    // A registration with no provider is the migration shape -- it serves any
    // selected provider -- so existing single-provider hosts keep working
    // while a provider-bound one takes precedence.
    let checkedDescriptor = null;
    if (descriptor !== null) {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new TypeError(`descriptor for ${name} must be an object`);
      }
      checkedDescriptor = structuredClone(descriptor);
    }
    this.#handlers.set(PrimitiveRegistry.key(name, provider), handler);
    if (checkedDescriptor) {
      this.#descriptors.set(PrimitiveRegistry.key(name, provider), checkedDescriptor);
    }
    return this;
  }

  static key(name, provider) {
    return provider ? `${name}@${provider}` : name;
  }

  has(name, provider = null) {
    return this.get(name, provider) !== null;
  }

  /**
   * The handler for a primitive under the SELECTED provider, falling back to
   * an unbound registration.
   */
  get(name, provider = null) {
    if (provider) {
      const bound = this.#handlers.get(PrimitiveRegistry.key(name, provider));
      if (bound) return bound;
    }
    return this.#handlers.get(name) ?? null;
  }

  descriptor(name, provider = null) {
    if (provider) {
      const bound = this.#descriptors.get(PrimitiveRegistry.key(name, provider));
      if (bound) return structuredClone(bound);
    }
    const descriptor = this.#descriptors.get(name);
    return descriptor ? structuredClone(descriptor) : null;
  }

  /** Primitive names, with any provider binding stripped. */
  names() {
    return [...new Set([...this.#handlers.keys()].map((k) => k.split("@")[0]))].sort();
  }

  /**
   * An immutable copy, taken once per host at construction.
   *
   * The live registry stays mutable for the caller that owns it; the host
   * holds the snapshot. That is what makes the effective revision below a
   * claim about what WILL run rather than what happened to be registered when
   * the revision was computed.
   */
  snapshot() {
    const frozen = new PrimitiveRegistry();
    for (const [key, handler] of this.#handlers) frozen.#handlers.set(key, handler);
    for (const [key, descriptor] of this.#descriptors) {
      frozen.#descriptors.set(key, structuredClone(descriptor));
    }
    for (const [name, rev] of this.#providerRevisions) frozen.#providerRevisions.set(name, rev);
    frozen.#frozen = true;
    return frozen;
  }

  get frozen() {
    return this.#frozen;
  }

  /**
   * A stable digest of provider identity, revision and exact membership.
   *
   * The preimage is byte-identical to the Python boundary's
   * `ProviderRegistry.fingerprint` (streamlit_trusted_host.py) -- same domain
   * line, same compact JSON separators, same key and member sorting. Two
   * implementations of one contract that fingerprint differently cannot check
   * each other, which is the whole point of a content identity.
   */
  fingerprint() {
    const byProvider = new Map();
    for (const key of this.#handlers.keys()) {
      const [primitive, provider = ""] = key.split("@");
      if (!byProvider.has(provider)) byProvider.set(provider, new Set());
      byProvider.get(provider).add(primitive);
    }
    const payload = [...byProvider.keys()].sort().map((provider) => {
      const implementsList = [...byProvider.get(provider)].sort();
      return {
        descriptors: Object.fromEntries(
          implementsList.flatMap((primitive) => {
            const descriptor = this.#descriptors.get(PrimitiveRegistry.key(primitive, provider));
            return descriptor ? [[primitive, descriptor]] : [];
          }),
        ),
        implements: implementsList,
        provider,
        revision: this.#providerRevisions.get(provider) ?? null,
      };
    });
    const preimage =
      "actions-json/provider-registry/v2\n" +
      stableRegistryJson(payload);
    return sha256Hex(preimage);
  }
}

const PROVIDER_REVISION = /^sha256:[0-9a-f]{64}$/;

function stableRegistryJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableRegistryJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${stableRegistryJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareUtf8(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/**
 * The effective host revision: installation revision AND what the host will
 * actually run, bound together.
 *
 * An installation revision alone changes when configuration changes and stays
 * put when the provider set does -- so two hosts running different code could
 * report the same revision, and a caller comparing revisions would conclude
 * they agree. Byte-identical preimage to the Python boundary.
 */
export function effectiveHostRevision(installationRevision, registry) {
  const preimage =
    "actions-json/streamlit-host-revision/v1\n" +
    `${installationRevision}\n${registry.fingerprint()}\n`;
  return `host-${sha256Hex(preimage).slice(0, 32)}`;
}

const nowIso = () => new Date().toISOString();

// Public error text is a stable class name, never the raw exception. A handler
// failure message routinely carries SQL text, account locators, connection
// identifiers or file paths, and this envelope crosses into a browser.
function sanitize(error) {
  const name = error?.name && typeof error.name === "string" ? error.name : "Error";
  return `${name}: handler raised an error; details are retained host-side`;
}


/**
 * A receipt ledger, scoped by tenant + viewer session + runtime.
 *
 * A rerun-based component boundary replays requests: the same user action can
 * arrive two or three times as the page re-executes. Without a ledger, each
 * delivery executes, so one click writes twice and nothing in the transcript
 * shows it happened.
 *
 * Injected rather than global because scope is the security property. Two
 * viewer sessions of one app must not consume each other's receipts, so a
 * colliding call_id across sessions is a distinct call, not a replay.
 */
// The receipt protocol ships in the merged contract (#337). Imported rather
// than reimplemented: this host previously carried a pre-contract ledger whose
// scope key, request digest, CAS conditions and liveness model had every one
// been superseded, and a second copy is a second thing to keep in step.
//
// Re-exported so existing consumers keep one import site.
export { DurableReceiptStore, authorityKey, requestDigest };
export const ReceiptLedger = DurableReceiptStore;
export class EmbedHost {
  #registry;
  #dictionary;
  #hostState;
  #send;
  #callContext;
  #runtimeId;
  #ledger;
  #trusted;
  #continuation;

  #signalManifest;

  constructor({
    dictionary,
    hostState,
    registry,
    send,
    callContext = {},
    runtimeId,
    signalManifest = [],
    ledger = null,
    scope = {},
  } = {}) {
    if (hostState?.host !== "embed") {
      throw new Error(`EmbedHost requires hostState.host === "embed"`);
    }
    if (typeof send !== "function") {
      throw new TypeError("EmbedHost requires a send function");
    }
    this.#dictionary = dictionary;
    // #340's rule: ONE immutable snapshot per host, taken here. The caller
    // keeps its live registry; this host does not see later registrations.
    // Before this, a handler registered after construction executed on an
    // already-built host -- so the host's advertised revision was a claim
    // about a capability surface that could still change underneath it.
    this.#registry = (registry ?? new PrimitiveRegistry()).snapshot();
    this.#hostState = hostState;
    for (const [namespace, namespaceState] of Object.entries(this.#hostState.namespaces ?? {})) {
      for (const [provider, registration] of Object.entries(namespaceState.registrations ?? {})) {
        const descriptors = {};
        const explicit = Array.isArray(registration.implements) ? registration.implements : [];
        const primitives = registration.implements_namespace === true
          ? this.#registry.names().filter((name) => name.split(".", 1)[0] === namespace)
          : explicit;
        for (const primitive of primitives) {
          const descriptor = this.#registry.descriptor(primitive, provider);
          if (descriptor) descriptors[primitive] = descriptor;
        }
        if (Object.keys(descriptors).length > 0) registration.descriptors = descriptors;
      }
    }
    this.#hostState.revision = effectiveHostRevision(this.#hostState.revision, this.#registry);
    this.#send = send;
    this.#callContext = callContext;
    this.#runtimeId = runtimeId ?? `embed-${Math.random().toString(36).slice(2, 10)}`;
    // Frozen at construction. A declaration supplied by the caller of
    // emitSignal would authorize its own emission, which is not a gate.
    this.#signalManifest = Object.freeze(
      signalManifest.map((signal) => Object.freeze({ ...signal })),
    );
    this.#ledger = ledger;

    // THE TRUSTED BINDING, derived once from host state and frozen.
    //
    // Every field here is server-derived. The browser previously supplied
    // scope through `withScope()` and `call.scope`, so it could replace
    // installation, tenant, continuation, session, principal (by omitting it)
    // and authority mode -- and reproducing that gave a SECOND execution of
    // the same call_id, defeating mutation idempotency from the untrusted
    // side. The wire envelope no longer carries authority at all.
    //
    // The one thing a browser may present is an opaque continuation token,
    // and it is a lookup HINT resolved strictly inside this binding.
    this.#trusted = Object.freeze({
      installation_id: hostState?.installation_id ?? scope.installation_id ?? null,
      tenant_id: hostState?.tenant_id ?? scope.tenant_id ?? null,
      principal_id: hostState?.principal_id ?? null,
      authority_mode: hostState?.authority_mode ?? "unspecified",
    });
    this.#continuation = scope.continuation_id ?? hostState?.session_id ?? null;
  }

  /**
   * The receipt-store key for this host, from trusted fields only.
   *
   * `runtime_id` is deliberately absent: a rerun rotates it, and keying on it
   * made every reconstruction a silent miss.
   */
  #authorityScope() {
    return { ...this.#trusted, continuation_id: this.#continuation };
  }

  get registry() {
    return this.#registry;
  }

  /**
   * A view of this host bound to one caller's scope.
   *
   * Scope is per-call, not per-host: one embedded app serves many viewer
   * sessions, so a constructor-global scope would let a misrouted envelope
   * execute under whichever host instance received it. Returning a bound view
   * keeps the ledger keyed by the caller's own identity.
   */
  withScope(scope) {
    if (!scope || Object.keys(scope).length === 0) return this;

    // Only the continuation is honoured, and only when it does not contradict
    // the authenticated principal. Everything else in a caller-supplied scope
    // is ignored rather than merged: a field that can be overridden from the
    // wire is not a trusted field, whatever it is called.
    if (scope.principal_id && scope.principal_id !== this.#trusted.principal_id) {
      const refusing = Object.create(this);
      refusing.handleActionCall = (call) =>
        EmbedHost.prototype._refusePrincipal.call(this, call);
      return refusing;
    }

    const bound = Object.create(this);
    const continuation = scope.continuation_id ?? scope.session_id ?? this.#continuation;
    bound.handleActionCall = (call) =>
      EmbedHost.prototype.handleActionCall.call(this, {
        ...call,
        scope: undefined,
        __continuation: continuation,
      });
    return bound;
  }

  get runtimeId() {
    return this.#runtimeId;
  }

  /**
   * What this host will advertise: the intersection of what the resolver
   * grants and what the registry implements.
   *
   * The intersection is the point. Granted-but-unimplemented is the
   * corpus.search defect; implemented-but-ungranted is a host claiming
   * authority it was not given. Both are reported rather than silently
   * dropped, because a capability that disappears without a word is how the
   * current defect stayed invisible.
   */
  /**
   * ONE recursive projection for everything crossing the browser boundary.
   *
   * The helpers existed in the contract and the host never called them, so a
   * raw provider identity reached the browser at multiple depths -- an account
   * locator is sensitive without being a credential, and testing forbidden key
   * NAMES does not catch a value under a permitted key.
   *
   * Full traces stay host-side behind the correlation id already on every
   * error.
   */
  #project(value) {
    return redactSnapshot(value);
  }

  catalog() {
    const resolved = resolveCatalog({
      dictionary: this.#dictionary,
      hostState: this.#hostState,
      callContext: this.#callContext,
    });

    const granted = new Set(
      resolved.primitives.filter((p) => p.support === "supported").map((p) => p.primitive),
    );
    const implemented = new Set(this.#registry.names());

    return this.#project({
      ...resolved,
      advertised: [...granted].filter((name) => implemented.has(name)).sort(),
      granted_but_unimplemented: [...granted].filter((name) => !implemented.has(name)).sort(),
      implemented_but_ungranted: [...implemented].filter((name) => !granted.has(name)).sort(),
    });
  }

  /**
   * Execute one action call.
   *
   * Authority is re-resolved HERE, at the executing boundary, not read from
   * whatever catalog the caller last saw. A catalog is a snapshot; execution
   * is the authority. That is what lets a capability be withdrawn mid-session
   * without wedging: the advertised tool stays in the model's context until
   * the next refresh, and calling it fails cleanly instead of executing with
   * authority that has been taken away.
   *
   * Note what is NOT here: a check that the caller holds the current
   * revision. Requiring that would invalidate every outstanding call on a
   * harmless config change, and realtime model context cannot be
   * synchronously retracted, so transient stale calls are ordinary.
   */
  async handleActionCall(call) {
    // The request schema names this field `primitive`; the extension's wire
    // envelope calls it `name`. Accept both rather than making the corpus and
    // the legacy transport disagree -- the schema's spelling is canonical.
    const name = call.primitive ?? call.name;

    // A caller-stable id is required when a ledger is in use. Generating one
    // would defeat dedupe silently: every replay would look like a new call,
    // which is exactly the duplicate-mutation case the ledger exists to stop.
    if (this.#ledger && !call.call_id) {
      return await this.#deliverError(
        `call-${Math.random().toString(36).slice(2)}`,
        "missing_call_id",
        "a stable call_id is required when a receipt ledger is active",
      );
    }
    const callId = call.call_id ?? `call-${Math.random().toString(36).slice(2)}`;

    if (this.#ledger) {
      // The wire envelope contributes NOTHING to authority. A continuation
      // presented by the caller is honoured only within this binding, and a
      // continuation that resolves to no row simply mints a new scope rather
      // than revealing that it belongs to someone else.
      // A presented token is ADMITTED, never adopted. Copying it into the
      // authority key let a caller pick its own continuation and get a second
      // execution of the same call_id -- the bypass survived my previous fix
      // because I blocked `call.scope` and left `withScope` free, and my own
      // test exercised the path I had already closed.
      //
      // admitContinuation resolves a token strictly inside the trusted
      // binding: a known one resumes, anything else mints a fresh
      // server-side scope rather than adopting the caller's value.
      const presented = call.__continuation ?? this.#continuation;
      const admitted = admitContinuation({
        trusted: this.#trusted,
        presented,
        store: this.#ledger,
      });
      if (admitted.outcome === "error") {
        return await this.#deliverError(callId, admitted.reason, "continuation was not admitted");
      }

      // Remember what was minted for THIS presented token, and remember it
      // server-side. Without this the same token mints a different scope on
      // every call -- so even the legitimate path could never dedupe, and a
      // caller presenting a different token simply got a different scope,
      // which is how a second mutation slipped through.
      //
      // The map is keyed by the presented value, so an attacker's token gets
      // its own scope and can never reach the receipts of another.
      // The mapping lives in the DURABLE store, not on this host: a
      // reconstructed host must reach the same scope, or every rerun mints a
      // fresh one and replay after reconstruction becomes impossible.
      const bindingKey = authorityKey({ ...this.#trusted, continuation_id: null });
      const continuation = this.#ledger.rememberContinuation
        ? this.#ledger.rememberContinuation(bindingKey, presented, admitted.continuation_id)
        : admitted.continuation_id;

      const scope = { ...this.#trusted, continuation_id: continuation };

      // Cross-principal attempts reject before the handler runs. Rejecting
      // after execution would be no protection at all: the work is already
      // done and the side effect already happened.
      const boundPrincipal = this.#trusted.principal_id;
      if (boundPrincipal && scope.principal_id && scope.principal_id !== boundPrincipal) {
        return await this.#deliverError(
          callId,
          "principal_mismatch",
          "call principal does not match the principal this host state was resolved for",
        );
      }

      // The contract's ordering: inspect -> resolve -> reserve -> execute
      // only from `acquired` -> conditional settle. A rejected call writes
      // nothing, and reserving before resolution is the wedge #337 closed.
      const key = authorityKey(scope);
        const resolved = resolveCapability({
        dictionary: this.#dictionary,
        hostState: this.#hostState,
        primitive: name,
        callContext: { ...this.#callContext, arguments: call.arguments ?? {} },
      });
      const digest = requestDigest({
        primitive: name,
        arguments: call.arguments ?? {},
        primitive_version: resolved.primitive_version ?? null,
      });

      const seen = this.#ledger.inspect(key, callId, digest);
      if (seen.state === "settled") {
        // Delivered as well as returned: a reconstructed or waiting browser
        // needs the terminal envelope, not just the caller's return value.
        return await this.#deliver(this.#fromReceipt(seen.receipt));
      }
      if (seen.state === "conflict") {
        return await this.#deliverError(
          callId, "call_id_conflict",
          "call_id was reused with a different request payload",
        );
      }
      if (seen.state === "in_flight") {
        // Both callers observe the same terminal result; marking one a replay
        // would make two views of one execution look like two.
        const terminal = seen.settled ? await seen.settled : null;
        if (terminal?.state === "settled_success") {
          // The owner's terminal result, VERBATIM -- including its
          // from_receipt tag. Both callers must observe the same object:
          // two views of one execution are not two executions, and a
          // differing tag is exactly what would make them look like two.
          return { ...(terminal.result ?? {}), from_receipt: false };
        }
        return await this.#deliverError(
          callId, "reconcile_required",
          "an owner is in flight and unreachable from this host",
        );
      }
      if (seen.state === "unknown_disposition") {
        // A reservation with no terminal receipt: a previous attempt began and
        // never finished, and nobody can say whether the side effect landed.
        return await this.#deliverError(
          callId, "unknown_disposition",
          "a previous attempt at this call_id began and never completed; its disposition is unknown",
        );
      }
      if (seen.state !== "absent") {
        return await this.#deliverError(
          callId, "reconcile_required", "unrecognised store state",
        );
      }

      // Only an absent row reaches capability resolution, and an unsupported
      // verdict returns before anything durable is written.
      if (resolved.support !== "supported") {
        // Carry the resolver's reason and trace. An agent told only "no"
        // cannot tell a capability it could enable from one it never can.
        return await this.#deliverError(
          callId, "capability_unavailable",
          `${name} is not available on this host`,
          {
            reason: resolved.reason,
            decided_by: resolved.decided_by,
            remediation: resolved.remediation,
          },
        );
      }
      if (!validateDescriptorInput(resolved.descriptor, call.arguments ?? {})) {
        return await this.#deliverError(callId, "invalid_arguments", "arguments do not match the selected provider descriptor");
      }

      const claim = this.#ledger.reserve(key, callId, digest, {
        provider: resolved.provider ?? null,
        primitive_version: resolved.primitive_version ?? null,
        effect: resolved.effect ?? null,
      });
      if (claim.state !== "acquired") {
        // Another host won the race between the read and the write. Every
        // outcome is handled as if it had, and none of them is execution.
        if (claim.state === "settled") {
          return await this.#deliver(this.#fromReceipt(claim.receipt));
        }
        return await this.#deliverError(
          callId,
          claim.state === "conflict" ? "call_id_conflict" : "reconcile_required",
          `the reservation was not acquired: ${claim.state}`,
        );
      }

      const produced = await this.#execute(call, callId, name, {
        defer: true,
        // The SAME object whose provider/version/effect was just recorded in
        // the reservation.
        resolved,
      });
      const { __undelivered, ...item } = produced;

      // BOTH outcomes settle. A handler failure was previously delivered and
      // never settled, leaving the row reserved -- so the next identical call
      // waited on a live in-flight owner that would never finish, and after
      // lease expiry became unknown_disposition. A failure is a terminal fact
      // about the call, not an absence of one.
      const failed = item.type === "action_error";
      const written = this.#ledger.settle(key, callId, {
        ...(failed ? { error: item.error } : { result: item }),
        owner_token: claim.owner_token,
        digest,
      });
      if (!written.ok) {
        // The crash window: the side effect may have landed while the receipt
        // did not. Never reported as terminal success.
        return await this.#deliverError(
          callId, "reconcile_required",
          `durable settlement failed: ${written.reason}`,
        );
      }
      // A fresh execution states so. The COALESCING caller is the one that
      // must not be tagged a replay -- two views of one execution are not two
      // executions -- but an execution that actually happened here is not a
      // receipt read, and three vectors assert the distinction.
      // Durable first, delivered second -- for a failure as much as a success.
      // The browser learns the outcome only after the receipt exists.
      const terminal = { ...item, from_receipt: false };
      await this.#deliver(terminal);
      return terminal;
    }

    // No ledger, so no receipt custody exists on this host. A MUTATION must
    // not proceed: `preflight: durable_mutation_store_ready` is a claim about
    // the deployment, and a claim is not a store. Executing here was the
    // fail-open where the host trusted its own configuration instead of the
    // object that would actually record the receipt.
    const declared = resolveCapability({
      dictionary: this.#dictionary,
      hostState: this.#hostState,
      primitive: name,
      callContext: { ...this.#callContext, arguments: call.arguments ?? {} },
    });
    // UNDECLARED effect fails closed too. The shipped canonical dictionary
    // declares `effect` on zero of its 43 primitives, so a guard that fires
    // only on an explicit "mutation" is inert on the real artifact -- and my
    // test proved a path the shipped dictionary cannot take, by inventing a
    // fixture that declares it.
    //
    // Read-only must be DECLARED to be believed. An unknown effect with no
    // receipt custody is exactly the case where guessing is expensive.
    // The gate applies only where a MUTATION is actually possible. Refusing
    // every undeclared primitive would make a store-less host useless against
    // the shipped dictionary, which declares `effect` on none of its 43.
    //
    // So: a declared mutation always refuses; an UNDECLARED effect refuses
    // only when the host has told us mutations are expected here, via
    // preflight. A host that claims a durable store and then does not inject
    // one is the case worth failing closed on -- it is a configuration that
    // believes it can mutate.
    const effect = declared.effect ?? "undeclared";
    const claimsMutationCustody = this.#hostState?.preflight !== undefined;
    if (effect === "mutation" || (effect === "undeclared" && claimsMutationCustody)) {
      return await this.#deliverError(
        callId,
        "capability_unavailable",
        `${name} is not declared read-only and this host has no durable receipt store`,
        { reason: REASON.DURABLE_STORE_UNAVAILABLE, remediation: "provision_receipt_store" },
      );
    }
    if (declared.support === "supported"
        && !validateDescriptorInput(declared.descriptor, call.arguments ?? {})) {
      return await this.#deliverError(callId, "invalid_arguments", "arguments do not match the selected provider descriptor");
    }

    return await this.#execute(call, callId, name);
  }

  /** A caller claiming a principal that is not the authenticated one. */
  async _refusePrincipal(call) {
    return await this.#deliverError(
      call.call_id ?? `call-${Math.random().toString(36).slice(2)}`,
      "principal_mismatch",
      "the call claims a principal that is not the authenticated one",
    );
  }

  /**
   * The single guarded egress. A transport rejection is reported rather than
   * thrown: the receipt is already durable at this point, so a delivery
   * failure must not look like the call failing.
   */
  /**
   * ONE formatter for a terminal receipt, whichever way it was reached.
   *
   * Every read path spread `receipt.result`, so a settled_error replayed as
   * `{from_receipt:true}` with no error at all -- a failure that had been
   * durably recorded came back as an empty success shape. A single formatter
   * is what stops three call sites disagreeing about what a receipt contains.
   */
  #fromReceipt(receipt) {
    if (!receipt) return { from_receipt: true };
    if (receipt.state === "settled_error" || receipt.error) {
      return {
        type: "action_error",
        runtime_id: this.#runtimeId,
        error: receipt.error,
        from_receipt: true,
      };
    }
    return { ...(receipt.result ?? {}), from_receipt: true };
  }

  async #deliver(item) {
    try {
      await this.#send(item);
      return item;
    } catch (error) {
      return { ...item, delivery_error: sanitize(error) };
    }
  }

  async #deliverError(callId, code, message, extra = {}) {
    const item = {
      type: "action_error",
      call_id: callId,
      runtime_id: this.#runtimeId,
      error: { code, message, correlation_id: callId, ...extra },
    };
    try {
      await this.#send(item);
    } catch {
      /* delivery failure is reported to the caller, not thrown */
    }
    return item;
  }

  /**
   * @param defer  when true, a SUCCESS is returned undelivered so the caller
   *               can settle the receipt first. Success must not cross the
   *               browser boundary before it is durable: a failed settle
   *               otherwise produces both a visible success and a
   *               reconcile_required, and the browser has already been told
   *               the call completed.
   */
  async #execute(call, callId, name, { defer = false, resolved: given = null } = {}) {

    // Delivery is awaited. An unawaited send loses an async rejection
    // silently, and a synchronous throw after a successful handler was being
    // caught as handler_failed -- reporting the work as failed when it had
    // already happened, and then attempting a second send from the catch.
    const deliver = async (item) => {
      try {
        await this.#send(item);
        return item;
      } catch (error) {
        return { ...item, delivery_error: sanitize(error) };
      }
    };

    const fail = async (code, message, extra = {}) =>
      deliver({
        type: "action_error",
        call_id: callId,
        runtime_id: this.#runtimeId,
        error: { code, message, correlation_id: callId, ...extra },
      });

    // Resolve ONCE. When the caller already resolved for admission it passes
    // that exact object through: resolving a second time here meant the
    // immutable execution binding recorded at reserve could describe a
    // different provider, version or effect than the handler actually saw --
    // and live capability state can change between the two calls.
    const resolved = given ?? resolveCapability({
      dictionary: this.#dictionary,
      hostState: this.#hostState,
      primitive: name,
      callContext: { ...this.#callContext, arguments: call.arguments ?? {} },
    });

    if (resolved.support !== "supported") {
      // The reason and the trace travel with the refusal. An agent told only
      // "no" cannot tell a capability it could enable from one it never can.
      // The trace stays host-side: `decisions` names providers, and a browser
      // needs the diagnosis, not the internals that produced it.
      return await fail("capability_unavailable", `${name} is not available on this host`, {
        reason: resolved.reason,
        decided_by: resolved.decided_by,
        remediation: resolved.remediation,
        // The current revision IS for the browser: it is the refresh signal
        // that lets a caller know its catalog is stale. Only the decision
        // trace stays host-side.
        // The refusal envelope keeps this at the top level -- an agent reads
        // it to learn which revision withdrew the capability. The resolution
        // itself carries it inside `authority`, where the schema requires it.
        installation_revision: resolved.authority?.installation_revision ?? null,
      });
    }
    if (!validateDescriptorInput(resolved.descriptor, call.arguments ?? {})) {
      return await fail("invalid_arguments", "arguments do not match the selected provider descriptor");
    }

    // Bound to the provider resolution selected, so the handler that runs is
    // the one the execution binding names.
    const handler = this.#registry.get(name, resolved.provider ?? null);
    if (!handler) {
      // Granted but unimplemented. Reported as its own code rather than as a
      // generic failure, because this is the exact state the registry exists
      // to make visible.
      return await fail("handler_missing", `${name} is granted on this host but no handler is registered`, {
        reason: REASON.CAPABILITY_UNAVAILABLE,
      });
    }

    try {
      const output = await handler(call.arguments ?? {}, {
        callId,
        runtimeId: this.#runtimeId,
        resolved,
      });
      const item = {
        type: "action_call_output",
        call_id: callId,
        runtime_id: this.#runtimeId,
        output: this.#project(output),
      };
      // Undelivered when deferred: the caller settles, then sends.
      return defer ? { ...item, __undelivered: true } : await deliver(item);
    } catch (error) {
      // A raw exception message can carry SQL, account identifiers, file
      // paths or provider internals across the boundary. The public error is
      // stable and sanitized; the raw text stays host-local.
      const failure = {
        type: "action_error",
        call_id: callId,
        runtime_id: this.#runtimeId,
        error: {
          code: "handler_failed",
          message: sanitize(error),
          correlation_id: callId,
          raw_available_in: "host_diagnostics",
        },
      };
      // Deferred like a success: the caller settles the terminal error first.
      return defer ? { ...failure, __undelivered: true } : await deliver(failure);
    }
  }

  /**
   * Emit a declared page-originated signal.
   *
   * `ingestion` is honoured here rather than declared and ignored -- in the
   * extension the field is read by no code at all.
   *
   * The manifest is bound at construction and frozen. An earlier version took
   * the declarations as an argument here, so the caller supplied the
   * declaration that authorized its own emission: an inline
   * `{ ingestion: "enabled" }` published an arbitrary payload under an
   * arbitrary name. A gate that consults a value the untrusted side controls
   * is not a gate.
   */
  emitSignal(name, payload = {}) {
    const declared = this.#signalManifest.find((signal) => signal.name === name);
    if (!declared) {
      return { emitted: false, reason: "signal_not_declared" };
    }
    if (declared.ingestion !== "enabled") {
      return { emitted: false, reason: "ingestion_disabled" };
    }

    const item = {
      type: "dom_event",
      event: name,
      name,
      runtime_id: this.#runtimeId,
      observed_at: nowIso(),
      payload,
    };
    this.#send(item);
    return { emitted: true, item };
  }

  /**
   * Format a resolved catalog for a consumer. Refuses to re-select a host --
   * the affordance that let an extension-resolved catalog be served as embed.
   */
  formatCatalogFor(catalog, host) {
    return assertResolvedCatalogForHost(catalog, host);
  }
}
