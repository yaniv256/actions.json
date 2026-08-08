// Content-realm authority for projection snapshots and their bounded retrieval
// continuations. This module is deliberately pure: DOM extraction, graph
// construction, and semantic-provider work happen before activation.

const AUTHORITY_FIELDS = Object.freeze([
  "runtime_id",
  "tab_id",
  "navigation_epoch",
  "projection",
  "catalog_revision",
]);

const DEFAULTS = Object.freeze({
  snapshotTtlMs: 15 * 60_000,
  cursorTtlMs: 2 * 60_000,
  maxSnapshots: 16,
  maxCursors: 128,
});

export class ProjectionSnapshotStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProjectionSnapshotStoreError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ProjectionSnapshotStoreError(code, message, details);
}

function validateAuthority(authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    fail("authority_malformed", "Snapshot authority must be an object.");
  }
  const normalized = {};
  for (const field of AUTHORITY_FIELDS) {
    const value = authority[field];
    const validTab = field === "tab_id" && (Number.isInteger(value) || (typeof value === "string" && value !== ""));
    if (!validTab && (typeof value !== "string" || value === "")) {
      fail("authority_malformed", `Snapshot authority requires ${field}.`, { field });
    }
    normalized[field] = value;
  }
  return Object.freeze(normalized);
}

function authorityKey(authority) {
  return AUTHORITY_FIELDS.map((field) => JSON.stringify(authority[field])).join("\u001f");
}

function sameAuthority(left, right) {
  return AUTHORITY_FIELDS.every((field) => left[field] === right[field]);
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) fail("store_option_invalid", `${name} must be a positive integer.`, { name, value });
}

function cloneAndFreeze(value) {
  if (value === undefined) return undefined;
  const cloned = structuredClone(value);
  const freeze = (current) => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return current;
    for (const child of Object.values(current)) freeze(child);
    return Object.freeze(current);
  };
  return freeze(cloned);
}

function defaultRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  fail("secure_random_unavailable", "A cryptographically secure random identifier source is required.");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function indexUnique(nodes, signatureFor) {
  const index = new Map();
  for (const node of nodes) {
    const signature = signatureFor(node);
    if (signature === null) continue;
    const entries = index.get(signature) ?? [];
    entries.push(node.ref);
    index.set(signature, entries);
  }
  return index;
}

function stableAttributeSignature(node, names) {
  const entries = names
    .filter((name) => Object.hasOwn(node.attributes ?? {}, name))
    .map((name) => [name, node.attributes[name]]);
  return entries.length === 0 ? null : `${node.type}\u001f${canonical(entries)}`;
}

function structuralSignatures(graph) {
  const signatures = new Map();
  graph.roots.forEach((ref, index) => signatures.set(ref, `root:${index}:${graph.nodes.find((node) => node.ref === ref)?.type}`));
  const incoming = new Map();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.type);
    incoming.set(edge.to, list);
  }
  for (const node of graph.nodes) {
    if (signatures.has(node.ref)) continue;
    const types = incoming.get(node.ref) ?? [];
    if (types.length === 1 && node.type === "array") signatures.set(node.ref, `incoming:${types[0]}:${node.type}`);
  }
  return signatures;
}

function fingerprint(node, graph) {
  const outgoing = graph.edges
    .filter((edge) => edge.from === node.ref)
    .map((edge) => ({ type: edge.type, measures: edge.measures ?? {} }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return canonical({ type: node.type, label: node.label, attributes: node.attributes ?? {}, outgoing });
}

/**
 * Reissue graph refs, preserving a previous ref only when cheap evidence maps
 * one old node to one new node. A collision at a stronger evidence tier is
 * terminal for that node; weaker evidence must not guess through ambiguity.
 */
export function reconcileProjectionGraphRefs(
  graph,
  { previousGraph = null, declaredKeys = [], stableAttributes = ["url", "href", "permalink"], randomRef = defaultRandomId } = {},
) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.roots)) {
    fail("snapshot_graph_invalid", "A validated projection graph is required.");
  }
  const previousNodes = previousGraph?.nodes ?? [];
  const oldStructure = previousGraph ? structuralSignatures(previousGraph) : new Map();
  const newStructure = structuralSignatures(graph);
  const oldStructureIndex = indexUnique(previousNodes, (node) => oldStructure.get(node.ref) ?? null);
  const newStructureIndex = indexUnique(graph.nodes, (node) => newStructure.get(node.ref) ?? null);
  const oldFingerprints = indexUnique(previousNodes, (node) => fingerprint(node, previousGraph));
  const newFingerprints = indexUnique(graph.nodes, (node) => fingerprint(node, graph));
  const used = new Set();
  const mapping = new Map();
  let ambiguous = 0;

  const declaredTiers = declaredKeys.map((name) => [
    indexUnique(previousNodes, (node) => stableAttributeSignature(node, [name])),
    indexUnique(graph.nodes, (node) => stableAttributeSignature(node, [name])),
    (node) => stableAttributeSignature(node, [name]),
  ]);
  const stableTiers = stableAttributes.map((name) => [
    indexUnique(previousNodes, (node) => stableAttributeSignature(node, [name])),
    indexUnique(graph.nodes, (node) => stableAttributeSignature(node, [name])),
    (node) => stableAttributeSignature(node, [name]),
  ]);
  const tiers = [
    ...declaredTiers,
    ...stableTiers,
    [oldStructureIndex, newStructureIndex, (node) => newStructure.get(node.ref) ?? null],
    [oldFingerprints, newFingerprints, (node) => fingerprint(node, graph)],
  ];
  const allocated = new Set(previousNodes.map((node) => node.ref));
  const allocateRef = () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ref = `psn_${randomRef()}`;
      if (!allocated.has(ref)) {
        allocated.add(ref);
        return ref;
      }
    }
    fail("opaque_ref_collision", "Unable to allocate a unique opaque node reference.");
  };
  for (const node of graph.nodes) {
    let chosen = null;
    let collided = false;
    for (const [oldIndex, newIndex, signatureFor] of tiers) {
      const signature = signatureFor(node);
      if (signature === null) continue;
      const oldMatches = oldIndex.get(signature) ?? [];
      if (oldMatches.length === 0) continue;
      const newMatches = newIndex.get(signature) ?? [];
      if (oldMatches.length !== 1 || newMatches.length !== 1 || used.has(oldMatches[0])) {
        collided = true;
        break;
      }
      chosen = oldMatches[0];
      break;
    }
    if (collided) ambiguous += 1;
    const ref = chosen ?? allocateRef();
    if (chosen) used.add(chosen);
    mapping.set(node.ref, ref);
  }

  const rewriteLexicalPath = (path, oldRef, nextRef) => typeof path === "string" && path.startsWith(`${oldRef}/`)
    ? `${nextRef}${path.slice(oldRef.length)}`
    : path;
  const nodes = graph.nodes.map((node) => ({ ...node, ref: mapping.get(node.ref) }));
  const edges = graph.edges.map((edge) => ({ ...edge, from: mapping.get(edge.from), to: mapping.get(edge.to) }));
  const records = (graph.lexical_index?.records ?? []).map((record) => ({
    ...record,
    node_ref: mapping.get(record.node_ref),
    path: rewriteLexicalPath(record.path, record.node_ref, mapping.get(record.node_ref)),
  }));
  const preserved = used.size;
  return {
    graph: {
      ...graph,
      roots: graph.roots.map((ref) => mapping.get(ref)),
      nodes,
      edges,
      lexical_index: { ...(graph.lexical_index ?? {}), records },
    },
    transitions: {
      preserved,
      new: graph.nodes.length - preserved,
      removed: previousNodes.length - preserved,
      ambiguous,
    },
  };
}

export function createProjectionSnapshotStore(options = {}) {
  const config = { ...DEFAULTS, ...options };
  for (const name of ["snapshotTtlMs", "cursorTtlMs", "maxSnapshots", "maxCursors"]) assertPositiveInteger(name, config[name]);
  const now = config.now ?? Date.now;
  const randomId = config.randomId ?? defaultRandomId;
  const snapshots = new Map();
  const activeByAuthority = new Map();
  const snapshotTombstones = new Map();
  const cursors = new Map();
  const cursorTombstones = new Map();

  const allocateOpaque = (prefix, occupied) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = `${prefix}${randomId()}`;
      if (!occupied.has(value)) return value;
    }
    fail("opaque_id_collision", `Unable to allocate a unique ${prefix} identifier.`);
  };

  const tombstone = (handle, code) => {
    cursorTombstones.set(handle, code);
    while (cursorTombstones.size > config.maxCursors) cursorTombstones.delete(cursorTombstones.keys().next().value);
  };
  const snapshotTombstone = (snapshot, code) => {
    snapshotTombstones.set(snapshot.snapshot_id, { authority_key: snapshot.authority_key, code });
    while (snapshotTombstones.size > config.maxSnapshots) snapshotTombstones.delete(snapshotTombstones.keys().next().value);
  };
  const removeSnapshot = (snapshotId, code = "snapshot_stale") => {
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot) return;
    snapshots.delete(snapshotId);
    snapshotTombstone(snapshot, code);
    if (activeByAuthority.get(snapshot.authority_key) === snapshotId) activeByAuthority.delete(snapshot.authority_key);
    for (const [handle, cursor] of cursors) {
      if (cursor.snapshot_id !== snapshotId) continue;
      cursors.delete(handle);
      tombstone(handle, "cursor_stale");
    }
  };
  const enforceSnapshotBound = () => {
    while (snapshots.size > config.maxSnapshots) {
      const removable = [...snapshots.values()].find((snapshot) => activeByAuthority.get(snapshot.authority_key) !== snapshot.snapshot_id)
        ?? snapshots.values().next().value;
      removeSnapshot(removable.snapshot_id, "snapshot_evicted");
    }
  };
  const enforceCursorBound = () => {
    while (cursors.size > config.maxCursors) {
      const handle = cursors.keys().next().value;
      cursors.delete(handle);
      tombstone(handle, "cursor_evicted");
    }
  };
  const requireSnapshot = (authority, snapshotId, { active = false } = {}) => {
    const normalized = validateAuthority(authority);
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot) {
      const prior = snapshotTombstones.get(snapshotId);
      if (prior && prior.authority_key !== authorityKey(normalized)) fail("snapshot_authority_mismatch", "The snapshot belongs to another authority.");
      fail(prior?.code ?? "snapshot_not_found", prior ? "The snapshot is no longer usable." : "No snapshot exists for this authority.");
    }
    if (!sameAuthority(snapshot.authority, normalized)) fail("snapshot_authority_mismatch", "The snapshot belongs to another authority.");
    if (snapshot.expires_at <= now()) {
      removeSnapshot(snapshotId, "snapshot_expired");
      fail("snapshot_expired", "The projection snapshot has expired.", { snapshot_id: snapshotId });
    }
    if (active && activeByAuthority.get(snapshot.authority_key) !== snapshotId) {
      fail("snapshot_stale", "The projection snapshot has been superseded.", { snapshot_id: snapshotId });
    }
    return snapshot;
  };

  const activate = ({ authority, graph, declaredKeys = [], stableAttributes } = {}) => {
    const normalized = validateAuthority(authority);
    const key = authorityKey(normalized);
    const previous = snapshots.get(activeByAuthority.get(key));
    const reconciled = reconcileProjectionGraphRefs(graph, {
      previousGraph: previous?.graph,
      declaredKeys,
      ...(stableAttributes ? { stableAttributes } : {}),
      randomRef: randomId,
    });
    const activatedAt = now();
    const snapshotId = allocateOpaque("pss_", snapshots);
    const immutableGraph = cloneAndFreeze(reconciled.graph);
    const snapshot = Object.freeze({
      snapshot_id: snapshotId,
      authority: normalized,
      authority_key: key,
      graph: immutableGraph,
      transitions: Object.freeze(reconciled.transitions),
      activated_at: activatedAt,
      expires_at: activatedAt + config.snapshotTtlMs,
    });
    // Publication is the only mutation after all validation/reconciliation has
    // succeeded, so a thrown build cannot disturb the old active snapshot.
    snapshots.set(snapshotId, snapshot);
    activeByAuthority.set(key, snapshotId);
    if (previous) {
      for (const [handle, cursor] of cursors) {
        if (cursor.snapshot_id !== previous.snapshot_id) continue;
        cursors.delete(handle);
        tombstone(handle, "cursor_stale");
      }
    }
    enforceSnapshotBound();
    return snapshot;
  };

  return Object.freeze({
    activate,
    async buildAndActivate({ authority, build, declaredKeys = [], stableAttributes } = {}) {
      if (typeof build !== "function") fail("snapshot_builder_invalid", "build must be a function.");
      const graph = await build();
      return activate({ authority, graph, declaredKeys, stableAttributes });
    },
    getActive(authority) {
      const normalized = validateAuthority(authority);
      const snapshotId = activeByAuthority.get(authorityKey(normalized));
      if (!snapshotId) fail("snapshot_not_found", "No active snapshot exists for this authority.");
      return requireSnapshot(normalized, snapshotId, { active: true });
    },
    getSnapshot(authority, snapshotId) {
      if (typeof snapshotId !== "string" || snapshotId === "") fail("snapshot_id_malformed", "A snapshot ID is required.");
      return requireSnapshot(authority, snapshotId, { active: true });
    },
    createCursor({ authority, snapshot_id, query, scope = null, order = null, page_size = 5, offset = 0, retrieval_revision } = {}) {
      const snapshot = requireSnapshot(authority, snapshot_id, { active: true });
      if (!Number.isInteger(page_size) || page_size <= 0) fail("cursor_malformed", "page_size must be a positive integer.");
      if (!Number.isInteger(offset) || offset < 0) fail("cursor_malformed", "offset must be a non-negative integer.");
      if (typeof retrieval_revision !== "string" || retrieval_revision === "") fail("cursor_malformed", "retrieval_revision is required.");
      const handle = allocateOpaque("psc_", new Map([...cursors, ...cursorTombstones]));
      const createdAt = now();
      const record = cloneAndFreeze({
        handle,
        authority: snapshot.authority,
        snapshot_id,
        query,
        scope,
        order,
        page_size,
        offset,
        retrieval_revision,
        created_at: createdAt,
        expires_at: createdAt + config.cursorTtlMs,
      });
      cursors.set(handle, record);
      enforceCursorBound();
      return Object.freeze({ handle, expires_at: record.expires_at });
    },
    resolveCursor({ authority, handle } = {}) {
      validateAuthority(authority);
      if (typeof handle !== "string" || !/^psc_[A-Za-z0-9_-]+$/.test(handle)) fail("cursor_malformed", "The cursor handle is malformed.");
      const record = cursors.get(handle);
      if (!record) {
        const code = cursorTombstones.get(handle);
        fail(code ?? "cursor_invalid", code ? "The cursor is no longer usable." : "The cursor handle is unknown.");
      }
      if (!sameAuthority(record.authority, authority)) fail("cursor_authority_mismatch", "The cursor belongs to another authority.");
      if (record.expires_at <= now()) {
        cursors.delete(handle);
        tombstone(handle, "cursor_expired");
        fail("cursor_expired", "The cursor has expired.");
      }
      const activeId = activeByAuthority.get(authorityKey(record.authority));
      if (activeId !== record.snapshot_id) {
        cursors.delete(handle);
        tombstone(handle, "cursor_stale");
        fail("cursor_stale", "The cursor snapshot has been superseded.");
      }
      requireSnapshot(record.authority, record.snapshot_id, { active: true });
      return record;
    },
    cleanupNavigation({ runtime_id, tab_id, retain_navigation_epoch } = {}) {
      for (const snapshot of [...snapshots.values()]) {
        if (snapshot.authority.runtime_id !== runtime_id || snapshot.authority.tab_id !== tab_id) continue;
        if (retain_navigation_epoch !== undefined && snapshot.authority.navigation_epoch === retain_navigation_epoch) continue;
        removeSnapshot(snapshot.snapshot_id, "snapshot_stale");
      }
    },
    cleanupTab({ runtime_id, tab_id } = {}) {
      for (const snapshot of [...snapshots.values()]) {
        if (snapshot.authority.runtime_id === runtime_id && snapshot.authority.tab_id === tab_id) removeSnapshot(snapshot.snapshot_id, "snapshot_stale");
      }
    },
    inspectCounts() {
      return Object.freeze({ snapshots: snapshots.size, active: activeByAuthority.size, cursors: cursors.size });
    },
  });
}
