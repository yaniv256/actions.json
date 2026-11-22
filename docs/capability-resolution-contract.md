---
title: Capability Resolution Contract
nav_order: 3
parent: actions.json Format
---

# Capability Resolution Contract

Normative specification for how a host's capability set is resolved. Language-neutral: every resolver implementation — JavaScript, Rust, Python, or otherwise — conforms to this document and is verified against the shared vectors in
`contracts/capability-resolution/host-resolution.vectors.json`.

Design discussion and rulings are recorded in the project issue tracker (#335).

The shared corpus is currently `actions-json/capability-resolution-vectors/v4`. Version 4 is a
breaking contract revision: provider-selected effective descriptors and effective call effects
are now part of the closed `CapabilityResolution` shape. A consumer that only implements v3
must reject v4 at the corpus/version boundary; it must not validate v4 output against the v3
closed schema or discard the descriptor fields. Catalog and provider-registry fingerprints use
their corresponding v2 domains so a stale catalog cannot alias the new executable contract.

This document specifies contracts and precedence. It does not specify an implementation, and no resolver code accompanies it — the contract is reviewable on its own terms, before implementation becomes the design by default.

## 1. Why this exists

Capability resolution is currently projected through at least five surfaces that can disagree: `describePrimitiveCapability`, `primitiveCatalogForHost`, `primitiveManifestMetadata`, `buildRealtimeToolCatalog`, and `ensure_primitive_dictionary_tools` in Rust. Two failures follow from having no single contract:

1. **Context is dropped between projections.** `primitiveCatalogForHost` calls the descriptor without passing `context`, and `primitiveManifestMetadata` inherits that.
2. **The host selector is inert against the shipped artifact.** The packaged dictionary carries flat `support` with `adapters` stripped, so `buildRealtimeToolCatalog` returns byte-identical catalogs for `extension` and `embed` — advertising browser and file-transfer authority to a host that has neither.

The second is the more instructive failure. The API *looks* host-sensitive, and returns extension authority anyway. A projection that cannot be wrong out loud is the shape this contract exists to remove.

## 2. Input contracts

Three document kinds. A function accepts exactly one. Passing another is an error, never a heuristic fallback.

**Dispatch is on the document's declared kind, never on which fields happen to be present.** Field-shape sniffing — `typeof primitive.support === "string"` — is removed rather than repaired, because it is the mechanism by which one parameter name came to accept two incompatible contracts.

### 2.1 Canonical primitive contract

Host-independent definitions: name, version, stage, `namespace`, `capability_class`, `portable`, schemas, summary, fidelity vocabulary.

- **Must not** carry effective flat `support` at primitive level. That shape is what makes §2.3 confusable, so validation rejects it.
- **Must not** declare provider instances or imply that a first-party provider exists.
- **May** carry `adapters` during migration, as a declared compatibility input only (§5.1).

Every primitive declares its `namespace`, deterministically derived from the dotted prefix and validated against it. No second manually maintained taxonomy exists yet; an explicit divergent value can be introduced later without changing precedence.

### 2.2 Resolved capability snapshot

The output of resolution, and the only input a formatter accepts.

```
ResolvedCatalog {
  host                     // the host this was resolved FOR
  installation_revision    // state fingerprint it reflects
  catalog_fingerprint
  resolved_at
  primitives: [CapabilityResolution]
}
```

**Must not** accept a second `host` selector. A formatter given a `ResolvedCatalog` plus a host argument disagreeing with `catalog.host` fails closed with `host_mismatch`. Re-selecting a host over already-resolved output is the shipped bug expressed as an API affordance.

### 2.3 Legacy flat packaged metadata

Today's packaged shape: flat `support`, no `adapters`. Read only by a named compatibility parser, never by the resolver:

```
parseLegacyPackagedDictionary(document, { expectedHost })
```

- The document **must declare its own host**. One that does not fails with `host_undeclared` — a document that cannot say whose authority it encodes must not be projected as any host's.
- A declared host that disagrees with `expectedHost` fails with `host_mismatch`. There is no "flat support wins and host becomes inert" path.

The declaration already exists and is already ignored: both packaged copies carry `primitive_dictionary.host = "extension"`, and the bookmarklet's inline table carries `"embed"`. No code reads either. So failing closed requires no new metadata — only that a projection consult a declaration it was already given.

## 3. Layers

Five responsibilities. Each answers a different question, which is why the split is not mixed ownership.

| layer | answers |
|---|---|
| 1. Dictionary | what is this primitive, and what contract does it claim? |
| 2. Provider registration | which of those primitives does an implementation actually implement? |
| 3. Host state | which registered providers are active for this installation and principal, and are they healthy? |
| 4. Compatibility override | which narrow exceptions apply during migration? |
| 5. Call context | what do site, session, and request facts permit right now? |

**Support originates at layer 2.** The dictionary defines vocabulary and contracts; it never says a primitive is available. Registration proves an implementation exists. Activation (layer 3) selects configured registrations.

A provider may only claim primitives the dictionary defines. It cannot add primitive names or change their semantic identity. A registration may carry a complete **effective descriptor** for a primitive when its executable host contract differs from canonical. That descriptor is implementation evidence, not configuration minting a tool: it is selected with the provider and fingerprinted with the provider registry.

The descriptor compatibility rule is deliberately conservative:

- canonical parameter schemas cannot be silently retyped or weakened;
- canonical required fields remain required and a closed canonical object cannot be reopened;
- optional canonical parameters may be omitted and additional canonical parameters may be required;
- provable scalar/collection narrowing is limited to enum subsets, increased `minimum`/`exclusiveMinimum`/`minLength`/`minItems`/`minProperties`, decreased `maximum`/`exclusiveMaximum`/`maxLength`/`maxItems`/`maxProperties`, and recursively narrower object/array schemas; existing patterns, formats, multiples, references, and compound schemas must remain identical;
- an unknown keyword or a schema change whose subset relationship cannot be proved by that closed rule fails closed rather than relying on a provider's assertion that it is narrower;
- every provider-only input property must be declared in `extensions.input` with its authority significance (`same_as_primitive` or `additional_policy`) and effect significance (`same_as_primitive`, `read`, or `mutation`);
- those declarations are executable controls, not annotations: catalog resolution advertises them, while call-boundary resolution receives the actual arguments; a used `additional_policy` field must appear in the trusted host's per-primitive policy grant and a used `mutation` field upgrades the effective call effect to mutation before durable-receipt preflight and reservation;
- output schemas remain canonical unless an independently specified compatibility mechanism is added later;
- an unannotated added property, a declaration for no added property, or a descriptor for an unregistered primitive is a contract error and fails closed.

Existing registrations without descriptors use the canonical descriptor during migration. The resolved snapshot always carries the effective descriptor and its source. Catalog formatters use that resolved descriptor; they do not return to the canonical dictionary for schemas after provider selection. Catalog fingerprint v2 includes the canonical descriptor digest, so a schema swap cannot masquerade as the same catalog. Provider-registry fingerprint v2 likewise includes descriptor content in both JavaScript and Python; v1 remains the descriptor-free historical preimage and must not be reused for descriptor-bearing registries.

### 3.1 Monotonicity

**Every layer after 2 may only narrow.** A namespace being present cannot make supported a primitive its provider does not implement; an override cannot re-enable one the provider never registered; call context is final and narrow-only.

**What makes a stale catalog safe is not that it cannot over-advertise.** It can: a capability withdrawn after publication remains in the catalog, and in a realtime model's context, until the next refresh. An earlier draft of this document claimed a catalog "can never advertise more than a call would permit", which is false and would have justified trusting a catalog as authority.

The actual invariant is narrower and stronger: **advertisement never confers authority, and every execution boundary re-resolves current state.** A stale advertisement therefore produces a clean refusal carrying the current reason and revision, not an execution under withdrawn authority. Monotonicity is what keeps that refusal *predictable* — the answer can only have become more restrictive — but it is re-resolution, not monotonicity, that makes staleness safe.

It also removes an inversion in the first draft of this design, where a namespace defaulted to supported and overrides disabled everything unimplemented — which made the dictionary's silence mean "yes".

### 3.2 `capability_class` and `support` are different axes

`capability_class` classifies semantic authority, portability, and conformance expectations — `portable`, `privileged`, `debug`, `mixed`. It is **decoupled from availability**. `overlay.*` being privileged-but-embed-supported is not a contradiction: the first-party embed owns that privileged product surface.

`support` is two-valued: `supported` or `unsupported`. It answers "can this be called?". Degraded behavior travels as per-call fidelity, where a caller can act on it.

`partial` is not a third spelling of withheld. A leftover `partial` **fails validation** rather than silently becoming unsupported — silent degradation is how the stale catalog rule survived unnoticed after the implementation moved past it.

## 4. Resolution output

```
CapabilityResolution {
  primitive, host
  support: "supported" | "unsupported"
  reason: string | null
  decisions: [Decision]      // ordered, one per layer that spoke
  decided_by                 // derived: the final narrowing layer
  capability_class, portable, effect
  namespace, provider
  descriptor { summary, input_schema, output_schema?, source, provider_extensions }
  installation_revision
  metadata                   // non-secret only
}

Decision { layer, decision, source?, provider?, reason? }
```

The trace is required, not decorative. A resolution that cannot say which layer decided it is unauditable, and a singular origin field hides which namespace or provider got a primitive as far as the layer that finally narrowed it.

Top-level `support` and `reason` remain the effective answer. `decided_by` is derived and does not substitute for the trace.

### 4.1 Reason codes

Distinct because they lead to different remediation:

| reason | meaning | remediation |
|---|---|---|
| `namespace_unavailable` | no active provider for the primitive's declared namespace | user may install, configure, or activate a provider |
| `capability_unavailable` | provider active but does not register this primitive, **or** a later layer narrowed it | none, or policy-dependent — the trace says which |
| `provider_unavailable` | provider registered and selected, but initialization or health failed | transient; may recover |
| `host_unknown` | unrecognised host | none; the request is malformed |
| `host_mismatch` | document or snapshot declares a different host than requested | none; the request is malformed |
| `host_undeclared` | flattened document does not say whose authority it encodes | regenerate the artifact |

`provider_unavailable` must not collapse into either of the first two: a health failure and an unimplemented primitive are different facts, and conflating them makes a transient outage look permanent.

The externally stable top-level reason stays bounded; the trace carries precise source and layer.

### 4.2 Revision is diagnostic, not a lease

**Catalog revision is a refresh trigger, never a call precondition.**

- Execution always resolves against current state.
- If the primitive is still allowed, it executes — regardless of which revision the caller saw.
- If withdrawn, return the current reason plus the new revision, and schedule a catalog refresh.
- Reject for ambiguity only when provider or config identity changed such that the arguments are ambiguous or unsafe — not because any revision moved.

Requiring callers to hold a current revision would recreate an observed-revision protocol: a harmless metadata change would invalidate every outstanding tool call, and realtime model context cannot be synchronously retracted, so transient stale calls are ordinary rather than exceptional.

`installation_revision` is per installation, deterministic over authority-affecting non-secret normalized state — content-addressed rather than a counter, whose continuity is fragile across restore. Session and call-context facts (active tab, site policy) do not mutate it. A session records both the installation revision and its last catalog fingerprint.

### 4.3 Authority scope: installation AND principal

Authority binds to **installation plus authenticated principal**, never installation alone.

```
authority { installation_id, tenant_id, principal_id, session_id, runtime_id, authority_mode }
```

An earlier draft spelled this `{ installation_revision, principal_id, session_id, authority_mode }`, which contradicted the request schema and the store key in two ways worth naming.

**`installation_id`, not `installation_revision`.** The revision moves on any config change; keying authority to it would invalidate every outstanding call whenever an unrelated setting changed — the wedge §4.2 forbids. Identity is stable; the revision stays diagnostic.

**`session_id` is an opaque `continuation_id`, not a WebSocket session.** The browser carries it across a rerun so a reconstructed host can find the receipt, and it is an **untrusted lookup token**: the trusted side binds it to the authenticated tenant, installation and principal on every admission. A tab with no token starts a new continuity scope — losing it loses replay convenience and must never broaden authority. A token presented by a different authenticated principal is refused before the lookup discloses anything.

The authenticated principal comes from the trusted side (on Streamlit, `st.user.user_name`), never from a browser-supplied value.

Installation alone is too coarse in both directions we care about. One installation can serve many tenants; and one embedded app serves many viewer sessions, so a provider selection or a resolved catalog made for principal A must never authorize principal B. A catalog resolved for one principal and presented by another resolves `unsupported` with `principal_mismatch`.

`principal_id` and `session_id` are opaque in diagnostics. They are identifiers, not credentials, and not account locators.

`authority_mode` records **whose privileges execute** — `owner_rights`, `caller_rights`, or `unspecified`. Two providers differing only in authority mode are different authorities: the mode is part of the installation revision preimage, and one is never silently substituted for the other. A query returning rows looks identical either way, which is exactly why the distinction cannot live in prose.

### 4.4 Secrets

Full host state stays internal. The diagnostic form is a **redacted snapshot**: revision, active namespaces and providers, effective support, decision traces, bounded public metadata.

`config_ref` is not serialized by default. A keychain name, file path, account locator, database identifier, or secret-store handle can be sensitive without being a credential. Use an opaque provider-instance id where a handle is needed.

For data namespaces, read-only scope, query bounds, allowed objects, and result limits are provider-enforced runtime policy, re-checked at call time. They are not fields a map can declare or weaken: a map asks, and the provider decides what it is permitted to ask for.

## 5. Migration

### 5.1 `adapters`

Compatibility input only. Dictionary owns the contract; provider registration owns membership; overrides become narrow-only exceptions.

For the realtime path there is **no working per-host behavior to preserve** — the flattening drops `adapters` before the shipped consumer sees it. So this is not "stop relying on `adapters`"; it is "start honoring host at all."

### 5.2 Language-neutral, not JS-owned

The normative assets are this specification, the resolution schema, and the shared vectors. **Three** implementations run against them under conformance tests, not two:

| implementation | executes at | why it is an authority, not a consumer |
|---|---|---|
| JavaScript | the browser/served runtime | resolves for the surface the agent acts on |
| Rust | the CLI/MCP boundary | its own process, its own authority; a transported decision would be stale by arrival |
| **Python** | the Streamlit trusted side | **the only side that touches the database.** A `data.*` call executes here, so this is where authority is finally enforced — a browser-side decision is advisory at best |

Python was omitted from earlier drafts of this list, which was not a documentation gap: it named JS and Rust as the implementations that must agree while leaving the one that actually executes database mutations outside the conformance set.

Each revalidates at its own execution boundary and never consumes a transported decision from another. Depending on a live resolver in another runtime would add a cross-runtime availability dependency to a path that must resolve locally anyway — and for the Python side it would put a network hop between a caller and a mutation.

Serialized resolved catalogs may be transported where that is natural. Authority resolution still happens at the executing boundary.

### 5.3 Characterization before implementation

The current packaged 76/76 result is pinned as a **defect characterization** — a record of what is wrong, so the fix is provably a change. It is explicitly not desired compatibility, and the characterization test says so where a future reader will find it.

## 6. Conformance

An implementation conforms when it passes every vector in the shared corpus.

**Vectors run against the packaged artifact, not only the canonical source.** A suite that runs only against canonical passes today while the shipped artifact leaks — which is precisely the gap that let this defect ship.

Cross-surface agreement is required across packaged extension, served embed, realtime, CLI/MCP, and diagnostics.

Two vectors deserve note because they are easy to satisfy vacuously:

- **Identical outputs across hosts** are accepted only when the underlying decision traces genuinely match — not because a selector was ignored. Comparing support values alone would pass today's defect.
- **A dictionary with per-host detail stripped fails loudly** rather than advertising everything. Silent full-advertise is the dangerous direction, and it is the current behavior.

## 7. Packaging is deployment metadata, not host identity

An embed host may be delivered more than one way. There are **three** projections, and they are not interchangeable:

| projection | delivery | lifecycle |
|---|---|---|
| `served-web` | ordinary served embed | direct in-page calls |
| `streamlit-container-v2` | package-based Components V2 with a local asset directory | callback semantics |
| `streamlit-warehouse-v1` | Components V1, shipped locally with the app | single-return-value plus rerun |

The warehouse projection is **not** a V2 inline build. Components V2 are unsupported in warehouse runtimes, so a warehouse host is V1 or it is nothing: either the V1 request/receipt lifecycle passes the contract tests, or warehouse support fails closed as unsupported. Silently omitting it would leave a host that appears to work and cannot.

In every projection the frontend ships locally with the app or package. No external script, CDN, remote iframe, or dynamic load — the platform's CSP forbids it, and an embed that depends on one is not deployable.

**The differences must not create three capability resolvers or three host identities.** All resolve as the same embed host against the same provider contract. Packaging appears in the host descriptor and deployment metadata, never in the authority scope, and identical host and provider state must produce identical resolved decisions — and identical catalog fingerprints — across projections.

### 7.1 The V1 rerun lifecycle

V1 returns one value and triggers a full script rerun, so the request/receipt protocol is not incidental — it is what makes the projection correct at all:

- the frontend sends one request envelope as its component value;
- the host side validates, authorizes, executes or deduplicates, stores the receipt, and reruns;
- the rerun returns the receipt plus the current resolved snapshot as component arguments;
- the ledger is keyed by installation + principal + viewer session + `call_id`, and persists across reruns;
- same `call_id` and same request digest replays the stored receipt without executing; same `call_id` with a different digest fails closed;
- every execution boundary re-resolves current host state. A snapshot or a revision is never authority.

### 7.2 Authority mode is not uniform across projections

Restricted caller rights are available only in the container runtime. A warehouse host cannot claim `caller_rights`, and a host descriptor that does is rejected rather than downgraded — silently substituting owner rights would change whose privileges execute a query, which is invisible in the result.

This also settles what a "served" embed means. Where the embedding platform applies a content-security policy that blocks externally loaded scripts and framed external applications, an embed cannot be a remotely loaded page. It is a **first-party implementation distributed for local inclusion by the containing host**. Anything that reaches an external service does so from the host's own trusted side, under that platform's governed outbound access, never as a browser-side escape from its CSP.

## 8. Contract assets

Normative and consumed identically by every implementation. They live in `contracts/capability-resolution/`, owned by neither runtime:

| asset | what it fixes |
|---|---|
| `host-resolution.vectors.json` | the cases every resolver must satisfy |
| `schemas/resolution.schema.json` | the resolution shape, with closed enums for layer, source, reason and remediation |
| `schemas/fingerprint.spec.md` | canonical preimage, encoding, algorithm, domain separation and exclusions |
| `schemas/golden-fingerprints.json` | computed digests; a divergent implementation is non-conforming even if self-consistent |

Closed enums are the point of the schema. A trace whose `layer` or `reason` is free text cannot be compared across languages, and a `remediation` an agent must infer from prose is not machine-readable — the reason table promises different remediation for different reasons, so the resolution carries it as a field.
