import jsonata from "./vendor/jsonata.mjs";
import { parseStoragePath, siteHostMatchesPage } from "../storage-bundle.mjs";

const EXPRESSION_SLOT_PATTERN = /^\s*\{%\s*([\s\S]*?)\s*%\}\s*$/;
const DISALLOWED_JSONATA_FUNCTIONS = /\$(eval|random|now|millis)\s*\(/i;

const DEFAULT_LIMITS = {
  maxStateBytes: 48_000,
  maxSummaryBytes: 12_000,
  maxExpressionOutputBytes: 32_000,
};

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
        maps.push({ path: entry.path, parsed, map });
      }
    } catch {
      // Invalid maps are ignored here; storage import remains the validation surface.
    }
  }
  return maps;
}

function findStateProjection(bundle, pageUrl, projectionName) {
  for (const { map } of loadStateProjectionMapsFromBundle(bundle, pageUrl)) {
    const projection = map.state_projections.find((candidate) => candidate?.name === projectionName);
    if (projection) return projection;
  }
  return null;
}

export function listStateProjectionsFromBundle(bundle, pageUrl) {
  const projections = [];
  for (const { map } of loadStateProjectionMapsFromBundle(bundle, pageUrl)) {
    for (const projection of map.state_projections) {
      if (validateStateProjection(projection).ok !== true) continue;
      projections.push({
        name: projection.name,
        description: typeof projection.description === "string" ? projection.description : null,
        summaries: Array.isArray(projection.summaries)
          ? projection.summaries.map((summary) => summary?.name).filter((name) => typeof name === "string" && name)
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
    if (!types.includes(actualType)) {
      errors.push({ path, message: `Expected ${types.join(" or ")} but got ${actualType}.` });
      return;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) errors.push({ path: `${path}/${requiredKey}`, message: "Required property is missing." });
    }
    for (const [key, nestedSchema] of Object.entries(schema.properties || {})) {
      if (key in value) valueMatchesSchema(value[key], nestedSchema, `${path}/${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => valueMatchesSchema(item, schema.items, `${path}/${index}`, errors));
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

export async function executeStateProjection({
  bundle,
  pageUrl,
  document,
  projectionName,
  summaryName = null,
  maxBytes = DEFAULT_LIMITS.maxStateBytes,
} = {}) {
  const projection = findStateProjection(bundle, pageUrl, projectionName);
  if (!projection) {
    return {
      ok: false,
      error: { code: "state_projection_not_found", message: "Requested state projection is not declared for this site." },
    };
  }
  const validation = validateStateProjection(projection);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  if (!document) {
    return {
      ok: false,
      error: { code: "state_document_unavailable", message: "State projection requires a DOM document." },
    };
  }
  const { records, diagnostics } = extractRecords(document, projection.snapshot.extract);
  let state;
  try {
    state = await evaluateJsonataExpression(projection.snapshot.projection.expression, {
      records,
      url: pageUrl,
      title: document?.title || "",
      projection: { name: projection.name },
    });
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
  const base = {
    ok: true,
    projection: projection.name,
    state_hash: stateHash(state),
    observed_at: new Date().toISOString(),
    diagnostics: {
      ...diagnostics,
      schema_valid: true,
      truncated: false,
    },
  };
  const summary = findSummary(projection, summaryName);
  if (summaryName && !summary) {
    return {
      ok: false,
      error: { code: "state_summary_not_found", message: "Requested state summary is not declared for this projection." },
    };
  }
  if (summary) {
    try {
      const summaryOutput = await evaluateJsonataExpression(
        summary.expression,
        { state, records, url: pageUrl, projection: { name: projection.name } },
        Math.min(Number(summary.max_bytes) || DEFAULT_LIMITS.maxSummaryBytes, DEFAULT_LIMITS.maxExpressionOutputBytes),
      );
      return {
        ...base,
        summary_name: summary.name,
        summary: summaryOutput,
      };
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code || "state_summary_failed", message: error.message || String(error) },
      };
    }
  }
  if (byteLength(state) > maxBytes) {
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
