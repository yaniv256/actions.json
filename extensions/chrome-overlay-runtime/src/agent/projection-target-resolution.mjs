const AUTHORITY_FIELDS = Object.freeze([
  "runtime_id",
  "tab_id",
  "navigation_epoch",
  "snapshot_id",
  "catalog_revision",
]);

const DEFAULT_MAX_CONTEXT_BYTES = 2_048;
const OPAQUE_NODE_REF = /^(?:psn_|node_)[A-Za-z0-9_-]+$/;

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stopped(reason, details = {}) {
  return Object.freeze({
    ok: false,
    outcome: "no_effect_performed",
    reason,
    ...details,
  });
}

function authorityFrom(value) {
  const nested = value?.authority && typeof value.authority === "object" ? value.authority : {};
  return Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, value?.[field] ?? nested[field]]));
}

function validAuthority(authority) {
  return AUTHORITY_FIELDS.every((field) => {
    const value = authority[field];
    return field === "tab_id"
      ? Number.isInteger(value) || (typeof value === "string" && value !== "")
      : typeof value === "string" && value !== "";
  });
}

function differingAuthorityField(expected, observed) {
  return AUTHORITY_FIELDS.find((field) => expected[field] !== observed[field]) ?? null;
}

function opaqueNodeRef(value) {
  return typeof value === "string" && OPAQUE_NODE_REF.test(value);
}

function uniqueSearchMatch(answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return { error: "search_answer_invalid" };
  }
  if (answer.status === "incomplete" || answer.complete === false || answer.coverage?.complete === false) {
    return { error: "search_incomplete" };
  }
  if (answer.status === "no_confident_match" || answer.status === "no_matches") {
    return { error: "no_confident_match" };
  }
  if (!Array.isArray(answer.matches)) return { error: "search_answer_invalid" };
  if (answer.matches.length === 0) return { error: "no_confident_match" };
  if (answer.matches.length !== 1 || answer.unique !== true) return { error: "search_ambiguous" };

  const match = answer.matches[0];
  const nodeRef = match?.node_ref ?? match?.ref;
  if (!opaqueNodeRef(nodeRef)) return { error: "opaque_node_ref_required" };
  const matchKind = match?.match_kind ?? match?.proof?.kind;
  if (matchKind !== "exact" && matchKind !== "opaque_node_ref") {
    return { error: matchKind === "partial_title" ? "partial_title_fallback_rejected" : "exact_match_proof_required" };
  }
  if (match?.confident !== true) return { error: "no_confident_match" };
  return { match, nodeRef };
}

function forwardReconciliation(observed, expectedRef) {
  const reconciliation = observed?.reconciliation;
  if (!reconciliation || reconciliation.unique !== true || reconciliation.from_node_ref !== expectedRef) return null;
  if (!opaqueNodeRef(reconciliation.to_node_ref) || typeof reconciliation.signal !== "string" || reconciliation.signal === "") return null;
  if ((observed.node_ref ?? observed.ref) !== reconciliation.to_node_ref) return null;
  return reconciliation;
}

/**
 * Resolve a search result into a bounded workflow target without performing an
 * effect. The injected resolver is intentionally called last, after all static
 * proof checks, so its observation is the immediate pre-effect authority read.
 */
export async function resolveProjectionEffectTarget({
  search_answer,
  expected_authority,
  resolveCurrentTarget,
  max_context_bytes = DEFAULT_MAX_CONTEXT_BYTES,
} = {}) {
  const selection = uniqueSearchMatch(search_answer);
  if (selection.error) return stopped(selection.error);
  if (typeof resolveCurrentTarget !== "function") return stopped("target_resolver_required");
  if (!Number.isInteger(max_context_bytes) || max_context_bytes < 256) return stopped("target_context_limit_invalid");

  const answerAuthority = authorityFrom(search_answer);
  const expectedAuthority = authorityFrom(expected_authority);
  if (!validAuthority(answerAuthority) || !validAuthority(expectedAuthority)) return stopped("authority_incomplete");
  const answerMismatch = differingAuthorityField(expectedAuthority, answerAuthority);
  if (answerMismatch) return stopped("cross_authority_target", { authority_field: answerMismatch });

  let observed;
  try {
    observed = await resolveCurrentTarget({
      node_ref: selection.nodeRef,
      authority: Object.freeze({ ...expectedAuthority }),
    });
  } catch (error) {
    return stopped("target_revalidation_failed", { resolver_code: error?.code ?? null });
  }
  if (!observed || observed.found !== true) return stopped("target_missing");

  const observedAuthority = authorityFrom(observed);
  if (!validAuthority(observedAuthority)) return stopped("authority_incomplete");
  const observedMismatch = differingAuthorityField(expectedAuthority, observedAuthority);
  if (observedMismatch) {
    const reason = observedMismatch === "navigation_epoch" || observedMismatch === "snapshot_id"
      ? "target_stale"
      : "cross_authority_target";
    return stopped(reason, { authority_field: observedMismatch });
  }

  const observedRef = observed.node_ref ?? observed.ref;
  let reconciliation = null;
  if (observedRef !== selection.nodeRef) {
    reconciliation = forwardReconciliation(observed, selection.nodeRef);
    if (!reconciliation) return stopped("target_moved");
  }

  const targetToken = Object.freeze({
    runtime_id: expectedAuthority.runtime_id,
    tab_id: expectedAuthority.tab_id,
    navigation_epoch: expectedAuthority.navigation_epoch,
    snapshot_id: expectedAuthority.snapshot_id,
    catalog_revision: expectedAuthority.catalog_revision,
    node_ref: observedRef,
  });
  const context = Object.freeze({
    target_token: targetToken,
    ...(reconciliation ? {
      reconciliation: Object.freeze({
        from_node_ref: reconciliation.from_node_ref,
        to_node_ref: reconciliation.to_node_ref,
        signal: reconciliation.signal,
      }),
    } : {}),
  });
  const contextBytes = byteLength(context);
  if (contextBytes > max_context_bytes) return stopped("target_context_too_large", { context_bytes: contextBytes });

  return Object.freeze({
    ok: true,
    outcome: "target_resolved",
    target_token: targetToken,
    context,
    context_bytes: contextBytes,
    reconciliation_applied: Boolean(reconciliation),
  });
}

export const PROJECTION_TARGET_AUTHORITY_FIELDS = AUTHORITY_FIELDS;
