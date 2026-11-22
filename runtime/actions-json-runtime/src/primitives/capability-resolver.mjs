// Capability resolution, per docs/capability-resolution-contract.md.
//
// One entry point. Every projection becomes a formatter over its result, so
// the realtime session, CLI/MCP, and diagnostics cannot disagree about what a
// host may do.
//
// The defect this replaces: resolution was spread across five surfaces, and
// the shipped one dispatched on which fields a document happened to carry
// (`typeof primitive.support === "string"`). That made one parameter name
// accept two incompatible input contracts -- an API that looked host-sensitive
// while returning extension authority for `host: "embed"`.
//
// So dispatch here is on a document's DECLARED kind, never on field shape.
// A document that does not say what it is, is an error rather than a guess.

import { sha256Hex } from "../crypto/sha256.mjs";

export const DOCUMENT_KIND = Object.freeze({
  CANONICAL: "canonical",
  RESOLVED_SNAPSHOT: "resolved_snapshot",
  LEGACY_FLAT: "legacy_flat",
});

export const LAYER = Object.freeze({
  DICTIONARY: "dictionary",
  PROVIDER_REGISTRATION: "provider_registration",
  HOST_STATE: "host_state",
  COMPATIBILITY_OVERRIDE: "compatibility_override",
  CALL_CONTEXT: "call_context",
});

/**
 * Machine-readable next action per reason. Present as a FIELD rather than a
 * prose table so an agent need not infer install/activate/retry/stop.
 */
export const REMEDIATION_FOR_REASON = Object.freeze({
  namespace_unavailable: "activate_provider",
  capability_unavailable: "none",
  provider_unavailable: "retry_later",
  provider_conflict: "fix_request",
  primitive_not_found: "fix_request",
  host_unknown: "fix_request",
  host_mismatch: "fix_request",
  host_undeclared: "fix_request",
  principal_mismatch: "fix_request",
  durable_store_unavailable: "provision_receipt_store",
});

export const REASON = Object.freeze({
  NAMESPACE_UNAVAILABLE: "namespace_unavailable",
  CAPABILITY_UNAVAILABLE: "capability_unavailable",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_CONFLICT: "provider_conflict",
  PRIMITIVE_NOT_FOUND: "primitive_not_found",
  HOST_UNKNOWN: "host_unknown",
  HOST_MISMATCH: "host_mismatch",
  HOST_UNDECLARED: "host_undeclared",
  PRINCIPAL_MISMATCH: "principal_mismatch",
  DURABLE_STORE_UNAVAILABLE: "durable_store_unavailable",
});

const KNOWN_HOSTS = new Set(["extension", "embed", "bookmarklet"]);

// Exactly the three states the contract defines. Anything else -- absent, a
// typo, a value from a newer host -- is not a state and must not grant.
const PREFLIGHT_STATES = new Set([
  "durable_mutation_store_ready",
  "setup_required",
  "read_only_ready",
]);
const VALID_SUPPORT = new Set(["supported", "unsupported"]);
const DESCRIPTOR_AUTHORITY = new Set(["same_as_primitive", "additional_policy"]);
const DESCRIPTOR_EFFECT = new Set(["same_as_primitive", "read", "mutation"]);

export class CapabilityContractError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "CapabilityContractError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Validate call arguments against the exact descriptor selected for execution. */
export function validateDescriptorInput(descriptor, value) {
  return validateSchemaValue(descriptor?.input_schema, value);
}

function validateSchemaValue(schema, value) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const handled = new Set([
    "type", "enum", "const", "properties", "required", "additionalProperties", "items",
    "minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties",
    "maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties",
    "pattern", "format", "multipleOf", "uniqueItems", "allOf", "anyOf", "oneOf",
    "not", "if", "then", "else", "title", "description", "default", "examples",
    "deprecated", "readOnly", "writeOnly",
  ]);
  if (Object.keys(schema).some((key) => !handled.has(key))) return false;
  const isNumber = (item) => typeof item === "number" && Number.isFinite(item);
  const checks = {
    object: (item) => item !== null && typeof item === "object" && !Array.isArray(item),
    array: Array.isArray,
    string: (item) => typeof item === "string",
    number: isNumber,
    integer: Number.isInteger,
    boolean: (item) => typeof item === "boolean",
    null: (item) => item === null,
  };
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || types.some((type) => !checks[type]) || !types.some((type) => checks[type](value))) return false;
  }
  const equal = (left, right) => stableJson(left) === stableJson(right);
  if (schema.enum && !schema.enum.some((item) => equal(item, value))) return false;
  if (Object.hasOwn(schema, "const") && !equal(schema.const, value)) return false;
  if (isNumber(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
    if (schema.multipleOf !== undefined && (!isNumber(schema.multipleOf) || schema.multipleOf <= 0
      || Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * 8)) return false;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false;
    if (schema.pattern !== undefined) {
      try { if (!new RegExp(schema.pattern, "u").test(value)) return false; } catch { return false; }
    }
    if (schema.format && !["uri", "uri-reference"].includes(schema.format)) return false;
    if (["uri", "uri-reference"].includes(schema.format) && /\s/u.test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(index + 1).some((other) => equal(item, other)))) return false;
    if (schema.items && value.some((item) => !validateSchemaValue(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return false;
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return false;
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some((name) => !Object.hasOwn(value, name)))) return false;
    const properties = schema.properties ?? {};
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        if (!validateSchemaValue(properties[name], child)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object"
        && !validateSchemaValue(schema.additionalProperties, child)) return false;
    }
  }
  if (schema.allOf && !schema.allOf.every((item) => validateSchemaValue(item, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((item) => validateSchemaValue(item, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((item) => validateSchemaValue(item, value)).length !== 1) return false;
  if (schema.not && validateSchemaValue(schema.not, value)) return false;
  if (schema.if) {
    const branch = validateSchemaValue(schema.if, value) ? schema.then : schema.else;
    if (branch && !validateSchemaValue(branch, value)) return false;
  }
  return true;
}

// -- document kinds ---------------------------------------------------------

/**
 * A canonical document carries host-independent contracts. It must not carry
 * effective flat `support` at primitive level: that is exactly the shape which
 * makes a canonical document indistinguishable from a packaged one.
 */
export function assertCanonicalDocument(document) {
  if (!document || !Array.isArray(document.primitives)) {
    throw new CapabilityContractError(
      "invalid_document",
      "canonical document requires a primitives array",
    );
  }

  // A leftover `partial` fails validation rather than silently degrading to
  // unsupported -- silent degradation is how the stale catalog rule survived
  // unnoticed after the implementation moved past it.
  for (const primitive of document.primitives) {
    for (const adapter of Object.values(primitive.adapters ?? {})) {
      if (adapter?.support !== undefined && !VALID_SUPPORT.has(adapter.support)) {
        throw new CapabilityContractError(
          "invalid_support_value",
          `support is two-valued; ${primitive.name} declares "${adapter.support}"`,
          { primitive: primitive.name, value: adapter.support },
        );
      }
    }
  }

  const offenders = document.primitives
    .filter((primitive) => typeof primitive.support === "string")
    .map((primitive) => primitive.name);

  if (offenders.length > 0) {
    throw new CapabilityContractError(
      "canonical_document_carries_flat_support",
      `canonical document must not carry flat support at primitive level: ${offenders.join(", ")}`,
      { primitives: offenders },
    );
  }

  return document;
}

/**
 * The named compatibility parser for today's packaged shape. It is deliberately
 * NOT the resolver: legacy documents are read here and nowhere else.
 *
 * The host declaration this checks already exists in every packaged artifact
 * and is currently read by nothing. Failing closed therefore costs no new
 * metadata -- only that a projection consult a declaration it was given.
 */
export function parseLegacyPackagedDictionary(document, { expectedHost } = {}) {
  if (!document || !Array.isArray(document.primitives)) {
    throw new CapabilityContractError(
      "invalid_document",
      "legacy packaged dictionary requires a primitives array",
    );
  }

  if (typeof document.host !== "string" || document.host.length === 0) {
    throw new CapabilityContractError(
      REASON.HOST_UNDECLARED,
      "legacy packaged dictionary does not declare the host whose authority it encodes",
    );
  }

  if (expectedHost !== undefined && document.host !== expectedHost) {
    throw new CapabilityContractError(
      REASON.HOST_MISMATCH,
      `legacy packaged dictionary declares host "${document.host}" but was requested as "${expectedHost}"`,
      { declared: document.host, requested: expectedHost },
    );
  }

  for (const primitive of document.primitives) {
    if (primitive.support !== undefined && !VALID_SUPPORT.has(primitive.support)) {
      throw new CapabilityContractError(
        "invalid_support_value",
        `support is two-valued; ${primitive.name} declares "${primitive.support}"`,
        { primitive: primitive.name, value: primitive.support },
      );
    }
  }

  return { host: document.host, primitives: document.primitives };
}

/**
 * A formatter accepts a resolved catalog and nothing else. Handing it a second
 * host selector is the shipped bug expressed as an API affordance, so a
 * disagreeing selector fails closed rather than silently re-selecting.
 */
export function assertResolvedCatalogForHost(catalog, host) {
  if (!catalog || typeof catalog.host !== "string") {
    throw new CapabilityContractError(
      "invalid_document",
      "resolved catalog must declare the host it was resolved for",
    );
  }
  if (host !== undefined && catalog.host !== host) {
    throw new CapabilityContractError(
      REASON.HOST_MISMATCH,
      `resolved catalog is for host "${catalog.host}" and cannot be formatted as "${host}"`,
      { resolved_for: catalog.host, requested: host },
    );
  }
  return catalog;
}

// -- namespace --------------------------------------------------------------

export function namespaceOf(primitiveName) {
  const index = primitiveName.indexOf(".");
  return index === -1 ? primitiveName : primitiveName.slice(0, index);
}

// -- resolution -------------------------------------------------------------

function resolution(base, decisions, { support, reason = null, decidedBy }) {
  return {
    ...base,
    support,
    reason,
    remediation: reason === null ? "none" : (REMEDIATION_FOR_REASON[reason] ?? "none"),
    decisions,
    decided_by: decidedBy,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
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

function sameSchema(left, right) {
  return stableJson(left) === stableJson(right);
}

const MINIMUM_KEYWORDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
const MAXIMUM_KEYWORDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];
const EXACT_KEYWORDS = [
  "pattern", "format", "multipleOf", "uniqueItems", "$ref",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
];
const ANNOTATION_KEYWORDS = ["title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"];
const HANDLED_SCHEMA_KEYWORDS = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  ...MINIMUM_KEYWORDS, ...MAXIMUM_KEYWORDS, ...EXACT_KEYWORDS, ...ANNOTATION_KEYWORDS,
]);

/** Conservative proof that `candidate` accepts no value rejected by `canonical`. */
function schemaNarrows(canonical, candidate) {
  if (sameSchema(canonical, candidate)) return true;
  if (!canonical || !candidate || typeof canonical !== "object" || typeof candidate !== "object"
    || Array.isArray(canonical) || Array.isArray(candidate)) return false;

  // Unknown/compound keywords need a real implication engine. Failing closed
  // is safer than guessing that a syntactically stronger-looking schema is a
  // semantic subset.
  for (const key of new Set([...Object.keys(canonical), ...Object.keys(candidate)])) {
    if (!HANDLED_SCHEMA_KEYWORDS.has(key)) return false;
  }
  if (canonical.type !== undefined && !sameSchema(canonical.type, candidate.type)) return false;

  if (canonical.enum !== undefined) {
    if (!Array.isArray(candidate.enum) || candidate.enum.length === 0) return false;
    const allowed = new Set(canonical.enum.map(stableJson));
    if (!candidate.enum.every((value) => allowed.has(stableJson(value)))) return false;
  }
  if (canonical.const !== undefined && !sameSchema(canonical.const, candidate.const)) return false;

  for (const key of MINIMUM_KEYWORDS) {
    if (canonical[key] !== undefined
      && (typeof candidate[key] !== "number" || candidate[key] < canonical[key])) return false;
  }
  for (const key of MAXIMUM_KEYWORDS) {
    if (canonical[key] !== undefined
      && (typeof candidate[key] !== "number" || candidate[key] > canonical[key])) return false;
  }
  for (const key of EXACT_KEYWORDS) {
    if (canonical[key] !== undefined && !sameSchema(canonical[key], candidate[key])) return false;
  }

  const canonicalRequired = new Set(canonical.required ?? []);
  const candidateRequired = new Set(candidate.required ?? []);
  for (const name of canonicalRequired) if (!candidateRequired.has(name)) return false;

  const canonicalProperties = canonical.properties ?? {};
  const candidateProperties = candidate.properties ?? {};
  for (const [name, property] of Object.entries(candidateProperties)) {
    if (!Object.prototype.hasOwnProperty.call(canonicalProperties, name)
      || !schemaNarrows(canonicalProperties[name], property)) return false;
  }
  for (const name of canonicalRequired) {
    if (!Object.prototype.hasOwnProperty.call(candidateProperties, name)) return false;
  }

  if (canonical.additionalProperties === false && candidate.additionalProperties !== false) return false;
  if (canonical.additionalProperties && typeof canonical.additionalProperties === "object") {
    if (!schemaNarrows(canonical.additionalProperties, candidate.additionalProperties)) return false;
  }
  if (canonical.items !== undefined && !schemaNarrows(canonical.items, candidate.items)) return false;
  return true;
}

/** Resolve the executable descriptor of the selected provider. */
export function resolveProviderDescriptor(entry, registration, primitive) {
  const canonicalInput = entry.input_schema ?? {
    type: "object",
  };
  const canonical = {
    summary: entry.summary,
    input_schema: canonicalInput,
    ...(entry.output_schema === undefined ? {} : { output_schema: entry.output_schema }),
    source: "dictionary",
    provider_extensions: {},
  };
  const overlay = registration?.descriptors?.[primitive];
  if (overlay === undefined) return canonical;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new CapabilityContractError("invalid_provider_descriptor", `${primitive} provider descriptor must be an object`);
  }
  const inputSchema = overlay.input_schema ?? canonicalInput;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || inputSchema.type !== "object") {
    throw new CapabilityContractError("invalid_provider_descriptor", `${primitive} input_schema must describe an object`);
  }

  const canonicalProperties = canonicalInput.properties ?? {};
  const providerProperties = inputSchema.properties ?? {};
  const declaredExtensions = overlay.extensions?.input ?? {};
  for (const [name, schema] of Object.entries(providerProperties)) {
    if (Object.prototype.hasOwnProperty.call(canonicalProperties, name)) {
      continue;
    }
    const declaration = declaredExtensions[name];
    if (!declaration || !DESCRIPTOR_AUTHORITY.has(declaration.authority) || !DESCRIPTOR_EFFECT.has(declaration.effect)) {
      throw new CapabilityContractError(
        "undeclared_provider_extension",
        `${primitive}.${name} is provider-specific and requires an authority/effect declaration`,
        { primitive, parameter: name },
      );
    }
  }
  const canonicalWithExtensions = structuredClone(canonicalInput);
  canonicalWithExtensions.properties = {
    ...(canonicalWithExtensions.properties ?? {}),
    ...Object.fromEntries(
      Object.entries(providerProperties).filter(([name]) => !Object.prototype.hasOwnProperty.call(canonicalProperties, name)),
    ),
  };
  if (!schemaNarrows(canonicalWithExtensions, inputSchema)) {
    throw new CapabilityContractError(
      "incompatible_provider_descriptor",
      `${primitive} provider input schema does not provably narrow the canonical contract`,
      { primitive },
    );
  }
  for (const name of Object.keys(declaredExtensions)) {
    if (!Object.prototype.hasOwnProperty.call(providerProperties, name) || Object.prototype.hasOwnProperty.call(canonicalProperties, name)) {
      throw new CapabilityContractError(
        "invalid_provider_extension",
        `${primitive}.${name} extension declaration must name one added input property`,
        { primitive, parameter: name },
      );
    }
  }
  if (overlay.output_schema !== undefined
    && (entry.output_schema === undefined || !sameSchema(overlay.output_schema, entry.output_schema))) {
    throw new CapabilityContractError(
      "incompatible_provider_descriptor",
      `${primitive} cannot silently replace the canonical output schema`,
      { primitive },
    );
  }

  return {
    summary: overlay.summary ?? entry.summary,
    input_schema: inputSchema,
    ...(overlay.output_schema === undefined && entry.output_schema === undefined
      ? {}
      : { output_schema: overlay.output_schema ?? entry.output_schema }),
    source: "provider_registration",
    provider_extensions: declaredExtensions,
  };
}

/**
 * Resolve one primitive for one host.
 *
 * Support ORIGINATES at provider registration and every later layer may only
 * narrow. The dictionary defines vocabulary and contracts; it never says a
 * primitive is available. That ordering is what makes a stale catalog safe:
 * it can never advertise more than a call would permit.
 */
export function resolveCapability({
  dictionary,
  hostState,
  primitive,
  callContext = {},
} = {}) {
  assertCanonicalDocument(dictionary);

  const host = hostState?.host;
  const entry = dictionary.primitives.find((item) => item.name === primitive);
  const namespace = entry?.namespace ?? namespaceOf(primitive);

  const base = {
    primitive,
    host: host ?? null,
    authority: {
      installation_revision: hostState?.revision ?? null,
      installation_id: hostState?.installation_id ?? null,
      principal_id: hostState?.principal_id ?? null,
      session_id: hostState?.session_id ?? null,
      authority_mode: hostState?.authority_mode ?? "unspecified",
    },
    capability_class: entry?.capability_class ?? null,
    portable: entry?.portable ?? false,
    effect: entry?.effect ?? null,
    namespace,
    provider: null,
    metadata: {},
    descriptor: entry
      ? {
          summary: entry.summary,
          input_schema: entry.input_schema,
          ...(entry.output_schema === undefined ? {} : { output_schema: entry.output_schema }),
          source: "dictionary",
          provider_extensions: {},
        }
      : null,
  };

  // Layer 1 -- the dictionary defines the vocabulary. A name it does not
  // define cannot be made available by any later layer.
  const decisions = [];
  if (!entry) {
    decisions.push({ layer: LAYER.DICTIONARY, decision: "unsupported", reason: REASON.PRIMITIVE_NOT_FOUND });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.PRIMITIVE_NOT_FOUND,
      decidedBy: LAYER.DICTIONARY,
    });
  }
  decisions.push({ layer: LAYER.DICTIONARY, decision: "defined", source: "canonical" });

  if (!KNOWN_HOSTS.has(host)) {
    decisions.push({ layer: LAYER.HOST_STATE, decision: "unsupported", reason: REASON.HOST_UNKNOWN });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.HOST_UNKNOWN,
      decidedBy: LAYER.HOST_STATE,
    });
  }

  // Layer 3 -- is a provider active for this namespace at all? Absent means
  // unsupported, and it is a DIFFERENT diagnosis from an active provider that
  // does not implement the primitive: the user may be able to fix this one.
  const namespaceState = hostState?.namespaces?.[namespace];
  if (!namespaceState) {
    decisions.push({
      layer: LAYER.HOST_STATE,
      decision: "unsupported",
      reason: REASON.NAMESPACE_UNAVAILABLE,
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.NAMESPACE_UNAVAILABLE,
      decidedBy: LAYER.HOST_STATE,
    });
  }

  // Deterministic provider selection. Two candidates with no selection is a
  // stated conflict, never an arbitrary winner -- otherwise capability would
  // depend on registration order.
  const provider = selectProvider(namespaceState);
  if (provider.absent || provider.unregistered) {
    // An empty or unbacked namespace grants nothing. Reported as
    // namespace_unavailable rather than capability_unavailable because the
    // remediation is the same as an absent namespace: activate a provider.
    decisions.push({
      layer: LAYER.HOST_STATE,
      decision: "unsupported",
      reason: REASON.NAMESPACE_UNAVAILABLE,
      source: provider.unregistered ? "provider_registration" : "provider_selection",
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.NAMESPACE_UNAVAILABLE,
      decidedBy: LAYER.HOST_STATE,
    });
  }
  if (provider.conflict) {
    decisions.push({
      layer: LAYER.HOST_STATE,
      decision: "unsupported",
      reason: REASON.PROVIDER_CONFLICT,
      source: provider.candidates.join(", "),
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.PROVIDER_CONFLICT,
      decidedBy: LAYER.HOST_STATE,
    });
  }
  base.provider = provider.name;
  decisions.push({
    layer: LAYER.HOST_STATE,
    decision: "active",
    provider: provider.name,
    source: provider.selectionRule,
  });

  // Layer 2 -- provider registration is where support first becomes true, and
  // it must SAY so. An omitted membership list previously meant "implements
  // everything", so a namespace object with no registration granted the whole
  // namespace. Membership is now explicit: a registration states its subset,
  // or states `implements_namespace: true` deliberately.
  const registration = provider.registration ?? namespaceState;
  const implemented = registration?.implements;
  const claimsWholeNamespace = registration?.implements_namespace === true;
  if (registration?.descriptors) {
    const unregisteredDescriptors = Object.keys(registration.descriptors).filter(
      (name) => claimsWholeNamespace
        ? namespaceOf(name) !== namespace
        : !Array.isArray(registration.implements) || !registration.implements.includes(name),
    );
    if (unregisteredDescriptors.length > 0) {
      throw new CapabilityContractError(
        "invalid_provider_descriptor",
        `provider descriptors must name registered primitives: ${unregisteredDescriptors.join(", ")}`,
        { primitives: unregisteredDescriptors },
      );
    }
  }
  const registers = claimsWholeNamespace
    ? true
    : Array.isArray(implemented) && implemented.includes(primitive);
  if (!registers) {
    decisions.push({
      layer: LAYER.PROVIDER_REGISTRATION,
      decision: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
      provider: provider.name,
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
      decidedBy: LAYER.PROVIDER_REGISTRATION,
    });
  }
  decisions.push({
    layer: LAYER.PROVIDER_REGISTRATION,
    decision: "supported",
    provider: provider.name,
  });
  base.descriptor = resolveProviderDescriptor(entry, registration, primitive);

  // Provider-only parameters can carry stronger authority/effect semantics.
  // Catalog resolution has no arguments and advertises those declarations;
  // call-boundary resolution supplies `arguments` and enforces them. Treating
  // the declarations as metadata only would let a canonically read-only
  // primitive perform a mutation without receipt custody.
  const callArguments = callContext?.arguments;
  if (callArguments && typeof callArguments === "object" && !Array.isArray(callArguments)) {
    const grantedPolicies = new Set(callContext?.provider_extension_policies?.[primitive] ?? []);
    for (const [parameter, declaration] of Object.entries(base.descriptor.provider_extensions ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(callArguments, parameter)) continue;
      if (declaration.authority === "additional_policy" && !grantedPolicies.has(parameter)) {
        decisions.push({
          layer: LAYER.CALL_CONTEXT,
          decision: "unsupported",
          reason: REASON.CAPABILITY_UNAVAILABLE,
          source: "session_policy",
        });
        return resolution(base, decisions, {
          support: "unsupported",
          reason: REASON.CAPABILITY_UNAVAILABLE,
          decidedBy: LAYER.CALL_CONTEXT,
        });
      }
      if (declaration.effect === "mutation") base.effect = "mutation";
      if (declaration.effect === "read" && base.effect == null) base.effect = "read_only";
    }
  }

  // Rung 1 of the evidence ladder: TRANSPORT gates every primitive, reads
  // included. Resolve the selected provider descriptor first: narrowing
  // availability must not erase which executable contract was selected.
  if (hostState?.projection !== undefined && hostState?.transport_status !== "supported") {
    decisions.push({
      layer: LAYER.HOST_STATE,
      decision: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
      decidedBy: LAYER.HOST_STATE,
    });
  }

  // Provider health is its own diagnosis. Collapsing it into either of the
  // two above would make a transient outage look permanent.
  if (namespaceState.health && namespaceState.health !== "available") {
    decisions.push({
      layer: LAYER.HOST_STATE,
      decision: "unsupported",
      reason: REASON.PROVIDER_UNAVAILABLE,
      source: "provider_health",
      provider: provider.name,
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.PROVIDER_UNAVAILABLE,
      decidedBy: LAYER.HOST_STATE,
    });
  }

  // Rung 2 of the evidence ladder: durable receipt custody, for primitives
  // whose EFFECT is a mutation. Effect comes from the primitive contract, not
  // a name list -- a provider can register `table.insert`, and `data.execute`
  // may be read-only under some contracts.
  //
  // Scoped to documents that declare `effect` at all: the shipped canonical
  // dictionary predates the field, and failing all of it closed would be a
  // migration break rather than a safety gain. A document declaring effect
  // ANYWHERE must declare it everywhere.
  const documentDeclaresEffect = dictionary.primitives.some((item) => item.effect !== undefined);
  if (documentDeclaresEffect && entry.effect === undefined) {
    decisions.push({ layer: LAYER.DICTIONARY, decision: "unsupported", reason: REASON.CAPABILITY_UNAVAILABLE });
    return resolution(base, decisions, {
      support: "unsupported", reason: REASON.CAPABILITY_UNAVAILABLE, decidedBy: LAYER.DICTIONARY,
    });
  }

  if (base.effect === "mutation") {
    const preflight = hostState?.preflight;
    // Absent or unrecognised is NOT a state: the safety property must not
    // depend on every producer remembering an optional field.
    if (!PREFLIGHT_STATES.has(preflight) || preflight === "setup_required") {
      // Names the layer actually missing. The provider IS active and
      // implements this primitive; activating it again cannot create a table.
      decisions.push({
        layer: LAYER.HOST_STATE, decision: "unsupported",
        reason: REASON.DURABLE_STORE_UNAVAILABLE, source: "provider_health",
      });
      return resolution(base, decisions, {
        support: "unsupported", reason: REASON.DURABLE_STORE_UNAVAILABLE, decidedBy: LAYER.HOST_STATE,
      });
    }
    if (preflight === "read_only_ready") {
      // A legitimate deployment, and not fixable by the reader.
      decisions.push({ layer: LAYER.HOST_STATE, decision: "unsupported", reason: REASON.CAPABILITY_UNAVAILABLE });
      return resolution(base, decisions, {
        support: "unsupported", reason: REASON.CAPABILITY_UNAVAILABLE, decidedBy: LAYER.HOST_STATE,
      });
    }
  }

  // Layer 4 -- narrow-only compatibility exceptions. Legacy `adapters` speaks
  // only when HostState explicitly selects that migration profile. A live
  // runtime provider registration is otherwise the availability authority;
  // bookmarklet-era metadata must not silently veto its implementation.
  const usesDictionaryAdapters = hostState?.compatibility_profile === "dictionary_adapters";
  const override = usesDictionaryAdapters ? entry.adapters?.[host] : null;
  if (override && override.support === "unsupported") {
    decisions.push({
      layer: LAYER.COMPATIBILITY_OVERRIDE,
      decision: "unsupported",
      reason: override.reason ?? REASON.CAPABILITY_UNAVAILABLE,
      source: "adapters",
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: override.reason ?? REASON.CAPABILITY_UNAVAILABLE,
      decidedBy: LAYER.COMPATIBILITY_OVERRIDE,
    });
  }
  if (override) {
    if (!VALID_SUPPORT.has(override.support)) {
      throw new CapabilityContractError(
        "invalid_support_value",
        `support is two-valued; ${primitive} declares "${override.support}" for host "${host}"`,
        { primitive, host, value: override.support },
      );
    }
    decisions.push({ layer: LAYER.COMPATIBILITY_OVERRIDE, decision: "supported", source: "adapters" });
  }

  // Layer 5 -- call context is final authority and narrow-only.
  //
  // Principal first: a provider selected for one authenticated principal must
  // not authorize another. One installation serves many tenants and one
  // embedded app serves many viewer sessions, so installation alone is too
  // coarse to bind authority.
  const callerPrincipal = callContext.principal_id ?? callContext.principal ?? null;
  if (callerPrincipal && hostState?.principal_id && callerPrincipal !== hostState.principal_id) {
    decisions.push({
      layer: LAYER.CALL_CONTEXT,
      decision: "unsupported",
      reason: REASON.PRINCIPAL_MISMATCH,
      source: "principal_scope",
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.PRINCIPAL_MISMATCH,
      decidedBy: LAYER.CALL_CONTEXT,
    });
  }

  const blocked = callContext.site_policy_blocks;
  if (Array.isArray(blocked) && blocked.includes(primitive)) {
    decisions.push({
      layer: LAYER.CALL_CONTEXT,
      decision: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
      source: "site_policy",
    });
    return resolution(base, decisions, {
      support: "unsupported",
      reason: REASON.CAPABILITY_UNAVAILABLE,
      decidedBy: LAYER.CALL_CONTEXT,
    });
  }

  return resolution(base, decisions, {
    support: "supported",
    reason: null,
    decidedBy: LAYER.PROVIDER_REGISTRATION,
  });
}

/**
 * Select the provider for a namespace, or refuse.
 *
 * Every path that cannot name a registered provider fails closed. The earlier
 * version returned `{ name: null }` for an empty namespace object and the
 * caller went on to grant the whole namespace -- config minting a registration
 * that no implementation had made, which is precisely what the contract
 * forbids. An absent provider is not a permissive default; it is the absence
 * of the thing that grants.
 */
function selectProvider(namespaceState) {
  const registrations = namespaceState?.registrations ?? null;

  // A configured selection must be backed by a registration. Naming a provider
  // in config does not make one exist.
  const configured = namespaceState?.provider ?? namespaceState?.selected ?? null;
  if (configured) {
    if (registrations && !Object.prototype.hasOwnProperty.call(registrations, configured)) {
      return { conflict: false, unregistered: configured };
    }
    return {
      name: configured,
      // `source` speaks the contract's closed layer vocabulary, not prose:
      // config-named and inferred providers are both the provider_selection
      // layer. The distinction is how the name was obtained, not which layer
      // decided, and emitting it here put "configured" -- a value no schema
      // enum contains -- into every catalog this resolver produced.
      selectionRule: "provider_selection",
      conflict: false,
      registration: registrations?.[configured] ?? null,
    };
  }

  const candidates = namespaceState?.candidates ?? [];
  if (candidates.length > 1) {
    // Determinism is not consent: candidates can be different tenants,
    // accounts, credentials or policy scopes.
    return { conflict: true, candidates };
  }
  if (candidates.length === 1) {
    const sole = candidates[0];
    if (registrations && !Object.prototype.hasOwnProperty.call(registrations, sole)) {
      return { conflict: false, unregistered: sole };
    }
    return {
      name: sole,
      selectionRule: "provider_selection",
      conflict: false,
      registration: registrations?.[sole] ?? null,
    };
  }

  // No provider, no candidates. An empty namespace object reaches here.
  return { conflict: false, absent: true };
}

/**
 * Resolve every primitive the dictionary defines into a snapshot. Formatters
 * consume this; nothing downstream re-selects a host.
 */
export function resolveCatalog({ dictionary, hostState, callContext = {} } = {}) {
  assertCanonicalDocument(dictionary);
  const primitives = dictionary.primitives.map((entry) =>
    resolveCapability({ dictionary, hostState, primitive: entry.name, callContext }),
  );
  return {
    // Required by resolved-catalog.schema.json: a formatter must be able to
    // tell a resolved snapshot from a canonical document by its declared kind
    // rather than by which fields happen to be present.
    kind: "resolved_snapshot",
    host: hostState?.host ?? null,
    installation_revision: hostState?.revision ?? null,
    catalog_fingerprint: fingerprint(primitives),
    resolved_at: null, // caller stamps; kept out so the function stays pure
    primitives,
  };
}

// Deterministic over the effective answers, so two catalogs that resolve alike
// fingerprint alike regardless of iteration order.
/**
 * The contract's catalog fingerprint: domain-separated SHA-256, truncated to
 * 16 bytes, over the canonical preimage in fingerprint.spec.md.
 *
 * This was a 32-bit FNV-1a rendered as eight hex characters -- a different
 * algorithm, a different length and no domain separation, so two conforming
 * implementations could never agree. A short non-cryptographic hash also
 * collides at a few tens of thousands of inputs, and these values are compared
 * across a trust boundary.
 *
 * `decided_by` is in the preimage: two catalogs with identical support that
 * reached it through different layers are not the same catalog.
 */
export function fingerprint(primitives) {
  // fingerprint.spec.md 2.2: four tab-separated fields, absent emitting the
  // empty string -- so the field count is fixed. Reading `decided_by` off an
  // entry that lacks it previously emitted the literal "undefined", which is a
  // digest no other implementation can reproduce.
  const line = (entry) =>
    typeof entry === "string"
      ? entry
      : [
          entry.primitive ?? "",
          entry.support ?? "",
          entry.reason ?? "",
          entry.decided_by ?? "",
          entry.descriptor == null ? "" : sha256Hex(stableJson(entry.descriptor)),
        ].join("\t");

  const preimage =
    "actions-json/catalog-fingerprint/v2\n" +
    primitives
      .map(line)
      // Byte-wise ordering of the UTF-8 encoding, per the spec. Array.sort()
      // compares UTF-16 code units, which disagrees above U+FFFF -- a
      // cross-language digest split that only ever shows on astral input.
      .sort(compareUtf8)
      .map((entry) => `${entry}\n`)
      .join("");
  return `cat-${sha256Hex(preimage).slice(0, 32)}`;
}

/**
 * Two hosts may legitimately resolve alike. That is only meaningful when the
 * decision traces agree -- identical support with no trace is the current
 * defect passing itself off as agreement.
 */
export function agreementIsVerifiable(left, right) {
  if (!Array.isArray(left?.decisions) || !Array.isArray(right?.decisions)) {
    return false;
  }
  if (left.support !== right.support) return false;
  if (left.decisions.length !== right.decisions.length) return false;
  return left.decisions.every((decision, index) => {
    const other = right.decisions[index];
    return decision.layer === other.layer && decision.decision === other.decision;
  });
}


/**
 * Validate a host descriptor before it can carry authority.
 *
 * Restricted caller rights exist only in the container runtime. A warehouse
 * descriptor claiming them is REJECTED rather than downgraded: silently
 * substituting owner rights changes whose privileges execute a query, and the
 * result rows look identical either way.
 */
export const PROJECTIONS = Object.freeze({
  "served-web": { authority_modes: ["owner_rights", "caller_rights", "unspecified"] },
  "streamlit-container-v2": { authority_modes: ["owner_rights", "caller_rights", "unspecified"] },
  "streamlit-warehouse-v1": { authority_modes: ["owner_rights", "unspecified"] },
});

export function validateHostDescriptor({ projection, authority_mode } = {}) {
  const known = PROJECTIONS[projection];
  if (!known) {
    return { outcome: "error", reason: "unknown_projection" };
  }
  if (authority_mode && !known.authority_modes.includes(authority_mode)) {
    return { outcome: "error", reason: "authority_mode_unavailable_for_projection" };
  }
  return { outcome: "ok", reason: null };
}

/**
 * Keys that must never reach a browser-visible payload, at any depth.
 *
 * A keychain name, account locator, or connection identifier is sensitive
 * without being a credential, so this list is wider than "secrets".
 */
const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "config_ref",
  "connection_identifier",
  "credential",
  "credentials",
  "secret_name",
  "account_locator",
  "password",
  "token",
]);

/**
 * Produce the browser-visible diagnostic snapshot.
 *
 * Recursive by construction: a top-level key filter would pass a forbidden key
 * nested one level inside provider metadata, which reaches a browser exactly
 * as readily as one at the root. The provider is rendered as an opaque
 * instance id rather than its configured name.
 */
export function redactSnapshot(node, { depth = 0 } = {}) {
  if (Array.isArray(node)) {
    return node.map((item) => redactSnapshot(item, { depth: depth + 1 }));
  }
  if (!node || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_DIAGNOSTIC_KEYS.has(key)) continue;
    if (key === "provider" && typeof value === "string") {
      out.provider = opaqueProviderId(value);
      continue;
    }
    out[key] = redactSnapshot(value, { depth: depth + 1 });
  }
  return out;
}

const OPAQUE_PREFIX = "provider-";

export function opaqueProviderId(name) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${OPAQUE_PREFIX}${hash.toString(16).padStart(8, "0")}`;
}

export function providerIsOpaque(snapshot) {
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
  return names.length > 0 && names.every((name) => name.startsWith(OPAQUE_PREFIX));
}
