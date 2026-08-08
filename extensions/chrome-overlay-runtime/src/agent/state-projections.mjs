import jsonata from "./vendor/jsonata.mjs";
import { parseStoragePath, siteHostMatchesPage } from "../storage-bundle.mjs";
import { graphifyProjection, ProjectionGraphError } from "./projection-graph.mjs";

const EXPRESSION_SLOT_PATTERN = /^\s*\{%\s*([\s\S]*?)\s*%\}\s*$/;
const DISALLOWED_JSONATA_FUNCTIONS = /\$(eval|random|now|millis)\s*\(/i;
const CACHE_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const STATE_PROJECTION_LIMITS = Object.freeze({
  publicResponseBytes: 48_000,
  internalComputeBytes: 4_000_000,
  internalTransferBytes: 4_000_000,
  diffResponseBytes: 48_000,
});
export const INTERNAL_STATE_PROJECTION_MAX_BYTES = STATE_PROJECTION_LIMITS.internalComputeBytes;

const DEFAULT_LIMITS = {
  maxStateBytes: STATE_PROJECTION_LIMITS.publicResponseBytes,
  maxSummaryBytes: 12_000,
  maxExpressionOutputBytes: 32_000,
  maxProjectionWorkingBytes: INTERNAL_STATE_PROJECTION_MAX_BYTES,
};

function stateOutputBudget(consumer, requestedBytes) {
  const hardMaximum = consumer === "internal_compute"
    ? STATE_PROJECTION_LIMITS.internalComputeBytes
    : STATE_PROJECTION_LIMITS.publicResponseBytes;
  const requested = Number(requestedBytes);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, hardMaximum)
    : hardMaximum;
}

function storageBundleEntries(bundle) {
  if (Array.isArray(bundle?.entries)) {
    return bundle.entries
      .filter((entry) => typeof entry?.path === "string")
      .map((entry) => ({
        path: entry.path,
        text: String(entry.content ?? entry.text ?? ""),
      }));
  }
  if (bundle?.files && typeof bundle.files === "object") {
    return Object.entries(bundle.files).map(([path, file]) => ({
      path,
      text: String(file?.text ?? ""),
    }));
  }
  return [];
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(value ?? ""))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function normalizeJsonValue(value) {
  if (value == null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function expressionFromSlot(value) {
  if (typeof value !== "string") return null;
  const match = value.match(EXPRESSION_SLOT_PATTERN);
  return match ? match[1] : value;
}

async function evaluateJsonataExpression(value, context, maxBytes = DEFAULT_LIMITS.maxExpressionOutputBytes) {
  const expressionSource = expressionFromSlot(value);
  if (typeof expressionSource !== "string" || !expressionSource.trim()) {
    throw new Error("JSONata expression is required.");
  }
  if (DISALLOWED_JSONATA_FUNCTIONS.test(expressionSource)) {
    const error = new Error("State projection JSONata expressions cannot use dynamic evaluation, randomness, or clock functions.");
    error.code = "disallowed_expression_function";
    throw error;
  }
  let expression;
  try {
    expression = jsonata(expressionSource);
  } catch (error) {
    error.code = "invalid_expression";
    throw error;
  }
  const output = normalizeJsonValue(await expression.evaluate(context));
  if (byteLength(output) > maxBytes) {
    const error = new Error("JSONata expression output exceeded the configured limit.");
    error.code = "expression_output_too_large";
    throw error;
  }
  return output;
}

function loadStateProjectionMapsFromBundle(bundle, pageUrl) {
  const maps = [];
  for (const entry of storageBundleEntries(bundle)) {
    const parsed = parseStoragePath(entry.path);
    if (!parsed || !parsed.sitePath.endsWith("actions.json") || !siteHostMatchesPage(parsed.siteHost, pageUrl)) {
      continue;
    }
    try {
      const map = JSON.parse(entry.text);
      if (map?.protocol === "actions.json" && Array.isArray(map.state_projections)) {
        maps.push({ path: entry.path, parsed, map, contentHash: fnv1a64(entry.text) });
      }
    } catch {
      // Invalid maps are ignored here; storage import remains the validation surface.
    }
  }
  return maps;
}

function wildcardPatternMatches(pattern, value) {
  if (typeof pattern !== "string" || !pattern.trim()) return true;
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(value || ""));
}

function projectionMatchesPage(projection, pageUrl) {
  const scope = projection?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return true;
  if (typeof scope.url_matches === "string" && !wildcardPatternMatches(scope.url_matches, pageUrl)) {
    return false;
  }
  return true;
}

function findStateProjection(bundle, pageUrl, projectionName) {
  for (const { path, parsed, map, contentHash } of loadStateProjectionMapsFromBundle(bundle, pageUrl)) {
    const projection = map.state_projections.find((candidate) => (
      candidate?.name === projectionName && projectionMatchesPage(candidate, pageUrl)
    ));
    if (projection) {
      return {
        projection,
        provenance: {
          map_path: path,
          content_hash: contentHash,
          map_version: map.version ?? null,
          site_host: parsed.siteHost,
        },
      };
    }
  }
  return null;
}

export function stateProjectionCacheNamespaces(bundle, pageUrl, projectionName) {
  const resolved = findStateProjection(bundle, pageUrl, projectionName);
  if (!resolved) return [];
  const { projection } = resolved;
  return [...new Set(projection.cache?.read_namespaces || [])];
}

export function resolveStateProjectionSemanticConfig(bundle, pageUrl, projectionName) {
  const resolved = findStateProjection(bundle, pageUrl, projectionName);
  if (!resolved || validateStateProjection(resolved.projection).ok !== true) return null;
  const semantic = resolved.projection.semantic;
  if (!semantic) return {
    policy: null,
    semantic_namespace: resolved.projection.name,
    provenance: structuredClone(resolved.provenance),
  };
  return {
    policy: structuredClone(semantic.policy),
    semantic_namespace: semantic.namespace || resolved.projection.name,
    provenance: structuredClone(resolved.provenance),
  };
}

export function listStateProjectionsFromBundle(bundle, pageUrl) {
  const projections = [];
  for (const { map } of loadStateProjectionMapsFromBundle(bundle, pageUrl)) {
    for (const projection of map.state_projections) {
      if (validateStateProjection(projection).ok !== true) continue;
      if (!projectionMatchesPage(projection, pageUrl)) continue;
      projections.push({
        name: projection.name,
        description: typeof projection.description === "string" ? projection.description : null,
        summaries: Array.isArray(projection.summaries)
          ? projection.summaries.map((summary) => summary?.name).filter((name) => typeof name === "string" && name)
          : [],
        summary_definitions: Array.isArray(projection.summaries)
          ? projection.summaries
              .filter((summary) => typeof summary?.name === "string" && summary.name)
              .map((summary) => ({
                name: summary.name,
                description: typeof summary.description === "string" ? summary.description : null,
                max_bytes: Number(summary.max_bytes) || DEFAULT_LIMITS.maxSummaryBytes,
                input_schema: summary.input_schema || null,
              }))
          : [],
      });
    }
  }
  return projections;
}

export function validateStateProjection(projection) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection must be an object." } };
  }
  if (typeof projection.name !== "string" || !projection.name) {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection needs a name." } };
  }
  const snapshot = projection.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection needs snapshot." } };
  }
  if (snapshot.version !== 1) {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection snapshot.version must be 1." } };
  }
  if (snapshot.source !== "dom") {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection snapshot.source must be dom." } };
  }
  if (!Array.isArray(snapshot.extract)) {
    return { ok: false, error: { code: "invalid_state_projection", message: "State projection snapshot.extract must be an array." } };
  }
  if (snapshot.projection?.language !== "jsonata" || typeof snapshot.projection?.expression !== "string") {
    return {
      ok: false,
      error: { code: "invalid_state_projection", message: "State projection snapshot.projection must declare JSONata expression." },
    };
  }
  if (projection.summaries != null) {
    if (!Array.isArray(projection.summaries)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection summaries must be an array." } };
    }
    const summaryNames = new Set();
    for (const summary of projection.summaries) {
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
        return { ok: false, error: { code: "invalid_state_projection", message: "Each state summary must be an object." } };
      }
      if (typeof summary.name !== "string" || !summary.name) {
        return { ok: false, error: { code: "invalid_state_projection", message: "Each state summary needs a name." } };
      }
      if (summaryNames.has(summary.name)) {
        return { ok: false, error: { code: "invalid_state_projection", message: `Duplicate state summary name "${summary.name}".` } };
      }
      summaryNames.add(summary.name);
      if (typeof summary.expression !== "string" || !summary.expression.trim()) {
        return { ok: false, error: { code: "invalid_state_projection", message: `State summary "${summary.name}" needs a JSONata expression.` } };
      }
      if (summary.max_bytes != null && (!Number.isFinite(Number(summary.max_bytes)) || Number(summary.max_bytes) <= 0)) {
        return { ok: false, error: { code: "invalid_state_projection", message: `State summary "${summary.name}" max_bytes must be positive.` } };
      }
      if (summary.input_schema != null) {
        if (
          typeof summary.input_schema !== "object" ||
          Array.isArray(summary.input_schema) ||
          summary.input_schema.type !== "object"
        ) {
          return {
            ok: false,
            error: {
              code: "invalid_state_projection",
              message: `State summary "${summary.name}" input_schema must be an object schema.`,
            },
          };
        }
      }
    }
  }
  if (projection.cache != null) {
    if (!projection.cache || typeof projection.cache !== "object" || Array.isArray(projection.cache)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection cache must be an object." } };
    }
    const readNamespaces = projection.cache.read_namespaces || [];
    if (!Array.isArray(readNamespaces) || readNamespaces.some((name) => !CACHE_NAMESPACE_PATTERN.test(name))) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection cache.read_namespaces must contain valid namespace strings." } };
    }
    const writes = projection.cache.writes || [];
    if (!Array.isArray(writes)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection cache.writes must be an array." } };
    }
    for (const write of writes) {
      if (
        !write
        || typeof write !== "object"
        || Array.isArray(write)
        || !CACHE_NAMESPACE_PATTERN.test(write.namespace)
        || typeof write.entries !== "string"
        || !write.entries.trim()
      ) {
        return { ok: false, error: { code: "invalid_state_projection", message: "Each projection cache write needs a valid namespace and entries expression." } };
      }
    }
  }
  if (projection.semantic != null) {
    const semantic = projection.semantic;
    if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection semantic declaration must be an object." } };
    }
    if (semantic.namespace != null && !CACHE_NAMESPACE_PATTERN.test(semantic.namespace)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection semantic.namespace must be a valid namespace." } };
    }
    const policy = semantic.policy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || !["all", "include", "exclude", "jsonata"].includes(policy.mode)) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection semantic.policy must declare all, include, exclude, or jsonata mode." } };
    }
    if (["include", "exclude"].includes(policy.mode) && (!Array.isArray(policy.fields) || policy.fields.length === 0 || policy.fields.some((field) => typeof field !== "string" || !field))) {
      return { ok: false, error: { code: "invalid_state_projection", message: `State projection semantic ${policy.mode} policy needs non-empty fields.` } };
    }
    if (policy.mode === "jsonata" && (typeof policy.expression !== "string" || !policy.expression.trim())) {
      return { ok: false, error: { code: "invalid_state_projection", message: "State projection semantic jsonata policy needs an expression." } };
    }
  }
  if (projection.markers != null) {
    // markers may be a static array, or a JSONata expression slot ("{% ... %}")
    // evaluated over { records, state, url } at projection time — marker DATA is
    // pure; the side-effecting resolution runs later in the action-layer runner.
    if (typeof projection.markers !== "string") {
      const markersValidation = validateStateMarkers(projection.markers);
      if (!markersValidation.ok) return markersValidation;
    }
  }
  return { ok: true };
}

// Recipe steps are declarative references to EXISTING portable primitives. The
// projection sandbox never executes them; the content-script marker-runner does.
export const MARKER_RECIPE_PRIMITIVES = new Set([
  "keyboard.press",
  "pointer.click",
  "pointer.move",
  "pointer.double_click",
  "locator.element_info",
  "locator.wait_for",
  "text.insert",
  "text.type",
  "viewport.scroll",
]);

const MARKER_PROMISE_TYPES = new Set(["cursor", "pointer"]);

export function validateStateMarkers(markers) {
  if (!Array.isArray(markers)) {
    return { ok: false, error: { code: "invalid_state_markers", message: "markers must be an array of marker objects." } };
  }
  const seen = new Set();
  for (const marker of markers) {
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
      return { ok: false, error: { code: "invalid_state_markers", message: "Each marker must be an object." } };
    }
    if (typeof marker.id !== "string" || !marker.id) {
      return { ok: false, error: { code: "invalid_state_markers", message: "Each marker needs a string id." } };
    }
    if (seen.has(marker.id)) {
      return { ok: false, error: { code: "invalid_state_markers", message: `Duplicate marker id "${marker.id}".` } };
    }
    seen.add(marker.id);
    if (!MARKER_PROMISE_TYPES.has(marker.type)) {
      return { ok: false, error: { code: "invalid_state_markers", message: `Marker "${marker.id}" type must be "cursor" or "pointer".` } };
    }
    if (!Array.isArray(marker.recipe) || marker.recipe.length === 0) {
      return { ok: false, error: { code: "invalid_state_markers", message: `Marker "${marker.id}" needs a non-empty recipe array.` } };
    }
    for (const step of marker.recipe) {
      if (!step || typeof step !== "object" || !MARKER_RECIPE_PRIMITIVES.has(step.primitive)) {
        return {
          ok: false,
          error: {
            code: "invalid_state_markers",
            message: `Marker "${marker.id}" recipe steps must name an allowed primitive (${[...MARKER_RECIPE_PRIMITIVES].join(", ")}).`,
          },
        };
      }
      if (step.args != null && (typeof step.args !== "object" || Array.isArray(step.args))) {
        return { ok: false, error: { code: "invalid_state_markers", message: `Marker "${marker.id}" recipe step args must be an object.` } };
      }
    }
  }
  return { ok: true };
}

function xpathAll(root, xpath) {
  if (!root || typeof xpath !== "string" || !xpath) return [];
  const doc = root.nodeType === 9 ? root : root.ownerDocument || root;
  if (!doc || typeof doc.evaluate !== "function") return [];
  const resultType = globalThis.XPathResult?.ORDERED_NODE_ITERATOR_TYPE || 5;
  let iterator;
  try {
    iterator = doc.evaluate(xpath, root, null, resultType, null);
  } catch {
    return [];
  }
  const hits = [];
  if (typeof iterator?.iterateNext === "function") {
    let node = iterator.iterateNext();
    while (node) {
      hits.push(node);
      node = iterator.iterateNext();
    }
    return hits;
  }
  if (typeof iterator?.snapshotLength === "number" && typeof iterator.snapshotItem === "function") {
    for (let index = 0; index < iterator.snapshotLength; index += 1) {
      const node = iterator.snapshotItem(index);
      if (node) hits.push(node);
    }
  }
  return hits;
}

function queryAll(root, locator) {
  if (!root || !locator || typeof locator !== "object") return [];
  if (typeof locator.selector === "string" && locator.selector) {
    if (typeof root.querySelectorAll !== "function") return [];
    return Array.from(root.querySelectorAll(locator.selector));
  }
  if (typeof locator.xpath === "string" && locator.xpath) {
    return xpathAll(root, locator.xpath);
  }
  return [];
}

function queryOne(root, locator) {
  if (!locator?.selector && !locator?.xpath) return root;
  if (typeof locator?.selector === "string" && locator.selector) {
    if (!root || typeof root.querySelector !== "function") return null;
    return root.querySelector(locator.selector);
  }
  return queryAll(root, locator)[0] || null;
}

function readRect(element) {
  const rect = typeof element?.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
  if (!rect) return null;
  return {
    x: Number(rect.x ?? rect.left ?? 0),
    y: Number(rect.y ?? rect.top ?? 0),
    width: Number(rect.width ?? 0),
    height: Number(rect.height ?? 0),
    top: Number(rect.top ?? rect.y ?? 0),
    left: Number(rect.left ?? rect.x ?? 0),
    right: Number(rect.right ?? (rect.left ?? rect.x ?? 0) + (rect.width ?? 0)),
    bottom: Number(rect.bottom ?? (rect.top ?? rect.y ?? 0) + (rect.height ?? 0)),
  };
}

function readProperty(element, property) {
  switch (property) {
    case "innerText":
    case "textContent":
    case "value":
    case "checked":
    case "ariaLabel":
      return element?.[property] ?? null;
    case "boundingClientRect":
      return readRect(element);
    default:
      return null;
  }
}

function readField(element, field, diagnostics, fieldPath) {
  const locator = { selector: field?.selector, xpath: field?.xpath };
  const hasLocator = Boolean(locator.selector || locator.xpath);
  if (field?.fields && typeof field.fields === "object" && !Array.isArray(field.fields) && hasLocator && field?.many) {
    const roots = queryAll(element, locator);
    diagnostics.selector_counts[fieldPath] = roots.length;
    return roots.map((root, index) => readFields(root, field.fields, diagnostics, `${fieldPath}.${index}`));
  }
  let target = hasLocator ? queryOne(element, locator) : element;
  if (target && field?.closest && typeof target.closest === "function") {
    target = target.closest(field.closest);
  }
  if (!target) {
    if (field?.required) diagnostics.missing_required_fields.push(fieldPath);
    return field?.default ?? null;
  }
  let value;
  if (field?.fields && typeof field.fields === "object" && !Array.isArray(field.fields)) {
    const roots = hasLocator && field.many ? queryAll(element, locator) : [target];
    if (hasLocator) diagnostics.selector_counts[fieldPath] = roots.length;
    const records = roots.map((root, index) => readFields(root, field.fields, diagnostics, `${fieldPath}.${index}`));
    return field.many ? records : records[0] ?? null;
  }
  if (typeof field?.attribute === "string") {
    value = typeof target.getAttribute === "function" ? target.getAttribute(field.attribute) : null;
  } else if (typeof field?.property === "string") {
    value = readProperty(target, field.property);
  } else {
    value = target?.innerText ?? target?.textContent ?? null;
  }
  if (typeof value === "string" && field?.trim) {
    value = value.trim();
  }
  if ((value == null || value === "") && field?.required) {
    diagnostics.missing_required_fields.push(fieldPath);
  }
  return value ?? field?.default ?? null;
}

function readFields(element, fields, diagnostics, pathPrefix) {
  const record = {};
  for (const [name, field] of Object.entries(fields || {})) {
    record[name] = readField(element, field, diagnostics, `${pathPrefix}.${name}`);
  }
  return record;
}

function extractRecords(document, extractors) {
  const records = {};
  const diagnostics = {
    missing_required_fields: [],
    selector_counts: {},
  };
  for (const extractor of extractors) {
    const id = extractor?.id;
    if (typeof id !== "string" || !id) continue;
    const locator = { selector: extractor.selector, xpath: extractor.xpath };
    const roots = locator.selector || locator.xpath ? queryAll(document, locator) : [document];
    diagnostics.selector_counts[id] = roots.length;
    if (extractor.fields && typeof extractor.fields === "object" && !Array.isArray(extractor.fields)) {
      const extracted = roots.map((root, index) => readFields(root, extractor.fields, diagnostics, `${id}.${index}`));
      records[id] = extractor.many === false ? extracted[0] ?? null : extracted;
    } else {
      records[id] = roots.map((root) => root.innerText ?? root.textContent ?? "");
    }
  }
  return { records, diagnostics };
}

function valueMatchesSchema(value, schema, path, errors) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matchesInteger = actualType === "number" && types.includes("integer") && Number.isInteger(value);
    if (!types.includes(actualType) && !matchesInteger) {
      errors.push({ path, message: `Expected ${types.join(" or ")} but got ${actualType}.` });
      return;
    }
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push({ path, message: `Expected a value greater than or equal to ${schema.minimum}.` });
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push({ path, message: `Expected a value less than or equal to ${schema.maximum}.` });
    }
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push({ path, message: `Expected at least ${schema.minLength} characters.` });
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push({ path, message: `Expected at most ${schema.maxLength} characters.` });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) errors.push({ path: `${path}/${requiredKey}`, message: "Required property is missing." });
    }
    for (const [key, nestedSchema] of Object.entries(schema.properties || {})) {
      if (key in value) valueMatchesSchema(value[key], nestedSchema, `${path}/${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const declaredKeys = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!declaredKeys.has(key)) errors.push({ path: `${path}/${key}`, message: "Additional property is not allowed." });
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => valueMatchesSchema(item, schema.items, `${path}/${index}`, errors));
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path, message: `Expected at least ${schema.minItems} items.` });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path, message: `Expected at most ${schema.maxItems} items.` });
    }
  }
}

function validateState(value, schema) {
  if (!schema) return { ok: true, errors: [] };
  const errors = [];
  valueMatchesSchema(value, schema, "", errors);
  return { ok: errors.length === 0, errors };
}

function findSummary(projection, summaryName) {
  const summaries = Array.isArray(projection.summaries) ? projection.summaries : [];
  if (!summaryName) return null;
  return summaries.find((summary) => summary?.name === summaryName) || null;
}

function stateHash(state) {
  let hash = 5381;
  const source = JSON.stringify(state);
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return `djb2:${hash.toString(16)}`;
}

function escapeJsonPointerSegment(segment) {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonPointer(parentPath, segment) {
  return `${parentPath}/${escapeJsonPointerSegment(segment)}`;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffValues(before, after, path, patches) {
  if (valuesEqual(before, after)) return;
  if (before === undefined) {
    patches.push({ op: "add", path, value: normalizeJsonValue(after) });
    return;
  }
  if (after === undefined) {
    patches.push({ op: "remove", path });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const commonLength = Math.min(before.length, after.length);
    for (let index = 0; index < commonLength; index += 1) {
      diffValues(before[index], after[index], jsonPointer(path, index), patches);
    }
    for (let index = commonLength; index < after.length; index += 1) {
      patches.push({ op: "add", path: jsonPointer(path, index), value: normalizeJsonValue(after[index]) });
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      patches.push({ op: "remove", path: jsonPointer(path, index) });
    }
    return;
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const key of keys) {
      diffValues(before[key], after[key], jsonPointer(path, key), patches);
    }
    return;
  }
  patches.push({ op: "replace", path, value: normalizeJsonValue(after) });
}

export function diffStates(before, after) {
  const patches = [];
  diffValues(before, after, "", patches);
  return patches;
}

function pointerSegments(path) {
  return String(path || "")
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function singularize(segment) {
  return segment.endsWith("s") && segment.length > 1 ? segment.slice(0, -1) : segment;
}

function entityKindFromPath(path) {
  const segments = pointerSegments(path);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (/^\d+$/.test(segment)) {
      const parent = segments[index - 1];
      return parent ? singularize(parent) : "item";
    }
  }
  return singularize(segments.at(-1) || "item");
}

function displayTitle(value) {
  if (!value || typeof value !== "object") return null;
  return value.title || value.name || value.id || null;
}

export function buildSemanticDeltas(patches) {
  if (!Array.isArray(patches)) return [];
  return patches.map((patch) => {
    const path = String(patch?.path || "");
    const segments = pointerSegments(path);
    const field = segments.at(-1) || "";
    if (patch?.op === "add") {
      const kind = entityKindFromPath(path);
      const entity = { kind };
      const title = displayTitle(patch.value);
      if (title) entity.title = title;
      return {
        type: "entity_added",
        entity,
        path,
        patch: normalizeJsonValue(patch),
      };
    }
    if (patch?.op === "remove") {
      return {
        type: "entity_removed",
        path,
        patch: normalizeJsonValue(patch),
      };
    }
    if (patch?.op === "replace") {
      return {
        type: "field_replaced",
        field,
        path,
        value: normalizeJsonValue(patch.value),
        patch: normalizeJsonValue(patch),
      };
    }
    return {
      type: "patch",
      path,
      patch: normalizeJsonValue(patch),
    };
  });
}

export async function verifyStatePostcondition({ postcondition, state, input = {} } = {}) {
  const verify = postcondition?.verify || postcondition;
  if (verify?.language !== "jsonata" || typeof verify?.expression !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_state_postcondition",
        message: "State postcondition must declare a JSONata verify expression.",
      },
    };
  }
  try {
    const passed = await evaluateJsonataExpression(verify.expression, { state, input }, DEFAULT_LIMITS.maxExpressionOutputBytes);
    if (passed) {
      return { ok: true };
    }
    return {
      ok: false,
      error: {
        code: "state_postcondition_failed",
        message: postcondition?.failure_message || "State postcondition did not pass.",
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || "state_postcondition_failed",
        message: error.message || String(error),
      },
    };
  }
}

async function searchableSnapshotDescriptor({
  state,
  projection,
  provenance,
  computedStateHash,
  observedAt,
  activateGraph,
} = {}) {
  const graph = graphifyProjection(state);
  const descriptor = {
    schema_version: 1,
    snapshot_id: null,
    projection: projection.name,
    observed_at: observedAt,
    roots: graph.roots,
    size: {
      nodes: graph.coverage.graph.node_count,
      edges: graph.coverage.graph.edge_count,
    },
    coverage: graph.coverage,
    source: provenance,
    active: false,
    navigation_ready: false,
    next_step: "snapshot_activation_required",
  };
  if (typeof activateGraph !== "function") return descriptor;

  const activated = await activateGraph({
    graph,
    lexicalIndex: graph.lexical_index,
    projection: {
      name: projection.name,
      description: typeof projection.description === "string" ? projection.description : null,
    },
    stateHash: computedStateHash,
    observedAt,
    coverage: graph.coverage,
    provenance,
  });
  if (!activated || typeof activated !== "object" || typeof activated.snapshot_id !== "string" || !activated.snapshot_id) {
    const error = new Error("Projection graph activation did not return a snapshot identifier.");
    error.code = "snapshot_activation_failed";
    throw error;
  }
  const activeDescriptor = {
    ...descriptor,
    snapshot_id: activated.snapshot_id,
    roots: Array.isArray(activated.roots) ? activated.roots : descriptor.roots,
    active: activated.active !== false,
    navigation_ready: activated.navigation_ready !== false,
  };
  delete activeDescriptor.next_step;
  return activeDescriptor;
}

export async function executeStateProjection({
  bundle,
  pageUrl,
  document,
  projectionName,
  summaryName = null,
  summaryArguments = {},
  maxBytes,
  consumer = "public_response",
  projectionCache = {},
  activateGraph,
} = {}) {
  const resolvedProjection = findStateProjection(bundle, pageUrl, projectionName);
  if (!resolvedProjection) {
    return {
      ok: false,
      error: { code: "state_projection_not_found", message: "Requested state projection is not declared for this site." },
    };
  }
  const { projection, provenance } = resolvedProjection;
  const validation = validateStateProjection(projection);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const summary = findSummary(projection, summaryName);
  if (summaryName && !summary) {
    return {
      ok: false,
      error: { code: "state_summary_not_found", message: "Requested state summary is not declared for this projection." },
    };
  }
  if (summary) {
    if (!summaryArguments || typeof summaryArguments !== "object" || Array.isArray(summaryArguments)) {
      return {
        ok: false,
        error: {
          code: "state_summary_input_validation_failed",
          message: "State summary arguments must be an object.",
          errors: [{ path: "", message: "Expected object summary arguments." }],
        },
      };
    }
    const summaryInputValidation = validateState(summaryArguments, summary.input_schema);
    if (!summaryInputValidation.ok) {
      return {
        ok: false,
        error: {
          code: "state_summary_input_validation_failed",
          message: "State summary arguments did not match the declared input schema.",
          errors: summaryInputValidation.errors,
        },
      };
    }
  }
  if (!document) {
    return {
      ok: false,
      error: { code: "state_document_unavailable", message: "State projection requires a DOM document." },
    };
  }
  const readableCache = {};
  for (const namespace of projection.cache?.read_namespaces || []) {
    if (projectionCache?.[namespace] && typeof projectionCache[namespace] === "object") {
      readableCache[namespace] = normalizeJsonValue(projectionCache[namespace]);
    }
  }
  const { records, diagnostics } = extractRecords(document, projection.snapshot.extract);
  let state;
  try {
    state = await evaluateJsonataExpression(
      projection.snapshot.projection.expression,
      {
        records,
        url: pageUrl,
        title: document?.title || "",
        projection: { name: projection.name },
        cache: readableCache,
      },
      DEFAULT_LIMITS.maxProjectionWorkingBytes,
    );
  } catch (error) {
    return {
      ok: false,
      error: { code: error.code || "state_projection_failed", message: error.message || String(error) },
    };
  }
  const schema = projection.snapshot.output_schema;
  const schemaValidation = validateState(state, schema);
  if (!schemaValidation.ok) {
    return {
      ok: false,
      error: {
        code: "state_schema_validation_failed",
        message: "State projection output did not match its schema.",
        errors: schemaValidation.errors,
      },
    };
  }
  let markers = null;
  if (projection.markers != null) {
    try {
      const resolved = typeof projection.markers === "string"
        ? await evaluateJsonataExpression(projection.markers, {
            records,
            state,
            url: pageUrl,
            projection: { name: projection.name },
            cache: readableCache,
          })
        : projection.markers;
      const markersValidation = validateStateMarkers(resolved);
      if (!markersValidation.ok) {
        return { ok: false, error: markersValidation.error };
      }
      markers = resolved;
    } catch (error) {
      if (error?.code === "expression_output_too_large") {
        try {
          const graphDescriptor = await searchableSnapshotDescriptor({
            state,
            projection,
            provenance,
            computedStateHash,
            observedAt,
            activateGraph,
          });
          if (byteLength(graphDescriptor) <= stateOutputBudget("public_response", maxBytes)) {
            return {
              ...base,
              summary_name: summary.name,
              summary_arguments: summaryArguments,
              summary_unavailable: {
                code: error.code,
                message: "The requested summary was too large; use the searchable snapshot instead.",
              },
              graph_descriptor: graphDescriptor,
            };
          }
        } catch (_fallbackError) {
          // Preserve the original summary error when graphification or activation
          // cannot produce a valid bounded alternative.
        }
      }
      return {
        ok: false,
        error: { code: error.code || "state_markers_failed", message: error.message || String(error) },
      };
    }
  }
  const cacheUpdates = [];
  for (const write of projection.cache?.writes || []) {
    try {
      const entries = await evaluateJsonataExpression(
        write.entries,
        { records, state, url: pageUrl, projection: { name: projection.name }, cache: readableCache },
        DEFAULT_LIMITS.maxExpressionOutputBytes,
      );
      if (!Array.isArray(entries)) {
        return {
          ok: false,
          error: { code: "state_projection_cache_failed", message: `Projection cache write "${write.namespace}" must produce an array.` },
        };
      }
      cacheUpdates.push({ namespace: write.namespace, entries });
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code || "state_projection_cache_failed", message: error.message || String(error) },
      };
    }
  }
  const observedAt = new Date().toISOString();
  const computedStateHash = stateHash(state);
  const base = {
    ok: true,
    projection: projection.name,
    state_hash: computedStateHash,
    observed_at: observedAt,
    ...(cacheUpdates.length > 0 ? { cache_updates: cacheUpdates } : {}),
    ...(markers ? { markers } : {}),
    diagnostics: {
      ...diagnostics,
      schema_valid: true,
      truncated: false,
    },
  };
  if (summary) {
    try {
      const declaredSummaryBudget = Number(summary.max_bytes) || DEFAULT_LIMITS.maxSummaryBytes;
      const callerBudget = stateOutputBudget("public_response", maxBytes);
      const summaryOutput = await evaluateJsonataExpression(
        summary.expression,
        { state, records, input: summaryArguments, url: pageUrl, projection: { name: projection.name }, cache: readableCache },
        Math.min(declaredSummaryBudget, callerBudget, DEFAULT_LIMITS.maxExpressionOutputBytes),
      );
      return {
        ...base,
        summary_name: summary.name,
        summary_arguments: summaryArguments,
        summary: summaryOutput,
      };
    } catch (error) {
      let fallbackFailure = null;
      if (error?.code === "expression_output_too_large") {
        try {
          const graphDescriptor = await searchableSnapshotDescriptor({
            state,
            projection,
            provenance,
            computedStateHash,
            observedAt,
            activateGraph,
          });
          if (byteLength(graphDescriptor) <= stateOutputBudget("public_response", maxBytes)) {
            return {
              ...base,
              summary_name: summary.name,
              summary_arguments: summaryArguments,
              summary_unavailable: {
                code: error.code,
                message: "The requested summary was too large; use the searchable snapshot instead.",
              },
              graph_descriptor: graphDescriptor,
            };
          }
        } catch (fallbackError) {
          fallbackFailure = fallbackError;
        }
      }
      return {
        ok: false,
        error: {
          code: error.code || "state_summary_failed",
          message: error.message || String(error),
          ...(fallbackFailure ? {
            fallback_error: {
              code: fallbackFailure.code || "searchable_snapshot_failed",
              message: fallbackFailure.message || String(fallbackFailure),
            },
          } : {}),
        },
      };
    }
  }
  const outputBudget = stateOutputBudget(consumer, maxBytes);
  if (consumer === "public_response") {
    try {
      const graphDescriptor = await searchableSnapshotDescriptor({
        state,
        projection,
        provenance,
        computedStateHash,
        observedAt,
        activateGraph,
      });
      if (byteLength(graphDescriptor) > outputBudget) {
        return {
          ok: false,
          error: {
            code: "state_payload_too_large",
            message: "State projection descriptor exceeded the configured payload budget.",
            available_summaries: Array.isArray(projection.summaries)
              ? projection.summaries.map((item) => item?.name).filter((name) => typeof name === "string" && name)
              : [],
          },
        };
      }
      return {
        ...base,
        graph_descriptor: graphDescriptor,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof ProjectionGraphError ? error.code : (error?.code || "projection_graph_failed"),
          message: error.message || String(error),
          ...(error instanceof ProjectionGraphError && Object.keys(error.details).length > 0
            ? { details: error.details }
            : {}),
        },
      };
    }
  }
  if (byteLength(state) > outputBudget) {
    return {
      ok: false,
      error: {
        code: "state_payload_too_large",
        message: "State projection output exceeded the configured payload budget.",
        available_summaries: Array.isArray(projection.summaries)
          ? projection.summaries.map((item) => item?.name).filter((name) => typeof name === "string" && name)
          : [],
      },
    };
  }
  return {
    ...base,
    state,
  };
}
