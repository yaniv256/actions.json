const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function validateProjectionCachePolicy(policy) {
  if (policy == null) return { ok: true };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, error: "Action cache policy must be an object." };
  }
  const allowedKeys = new Set(["invalidations"]);
  if (Object.keys(policy).some((key) => !allowedKeys.has(key))) {
    return { ok: false, error: "Action cache policy contains an unknown field." };
  }
  if (!Array.isArray(policy.invalidations) || policy.invalidations.length > 20) {
    return { ok: false, error: "Action cache invalidations must be an array of at most 20 entries." };
  }
  for (const invalidation of policy.invalidations) {
    if (!invalidation || typeof invalidation !== "object" || Array.isArray(invalidation)) {
      return { ok: false, error: "Each action cache invalidation must be an object." };
    }
    if (!SEGMENT_PATTERN.test(invalidation.namespace)) {
      return { ok: false, error: "Action cache invalidation namespace is invalid." };
    }
    if (
      invalidation.entity_id_argument != null
      && !SEGMENT_PATTERN.test(invalidation.entity_id_argument)
    ) {
      return { ok: false, error: "Action cache entity_id_argument is invalid." };
    }
    const allowedInvalidationKeys = new Set(["namespace", "entity_id_argument"]);
    if (Object.keys(invalidation).some((key) => !allowedInvalidationKeys.has(key))) {
      return { ok: false, error: "Action cache invalidation contains an unknown field." };
    }
  }
  return { ok: true };
}

export async function applyProjectionCacheInvalidations({ store, scope, policy, input = {} } = {}) {
  const validation = validateProjectionCachePolicy(policy);
  if (!validation.ok) throw new Error(validation.error);
  let invalidated = 0;
  for (const invalidation of policy?.invalidations || []) {
    const argumentName = invalidation.entity_id_argument;
    const entityId = typeof argumentName === "string" ? input?.[argumentName] : null;
    const result = typeof entityId === "string" && entityId
      ? await store.invalidate({ ...scope, namespace: invalidation.namespace, entityIds: [entityId] })
      : await store.invalidateNamespace({ ...scope, namespace: invalidation.namespace });
    invalidated += Number(result?.invalidated) || 0;
  }
  return { invalidated };
}
