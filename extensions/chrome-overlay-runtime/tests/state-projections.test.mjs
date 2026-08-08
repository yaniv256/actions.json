import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticDeltas,
  diffStates,
  executeStateProjection,
  listStateProjectionsFromBundle,
  resolveStateProjectionSemanticConfig,
  stateProjectionCacheNamespaces,
  verifyStatePostcondition,
  validateStateProjection,
} from "../src/agent/state-projections.mjs";

test("projection cache namespace discovery returns only the selected projection declarations", () => {
  const bundle = {
    entries: [{
      path: "scopes/public/sites/trello.com/board/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        version: 1,
        site: { host: "trello.com" },
        state_projections: [
          { name: "one", scope: { url_matches: "https://trello.com/b/*" }, cache: { read_namespaces: ["cards", "cards", "labels"] } },
          { name: "two", scope: { url_matches: "https://trello.com/b/*" }, cache: { read_namespaces: ["other"] } },
        ],
      }),
    }],
  };
  assert.deepEqual(
    stateProjectionCacheNamespaces(bundle, "https://trello.com/b/board", "one"),
    ["cards", "labels"],
  );
  assert.deepEqual(stateProjectionCacheNamespaces(bundle, "https://trello.com/b/board", "missing"), []);
});

test("semantic config resolves only a valid page-scoped projection declaration", () => {
  const projection = {
    name: "board",
    scope: { url_matches: "https://trello.com/b/*" },
    snapshot: { version: 1, source: "dom", extract: [], projection: { language: "jsonata", expression: "{}" } },
    semantic: { namespace: "trello.board", policy: { mode: "include", fields: ["title", "description"] } },
  };
  const bundle = { entries: [{
    path: "scopes/public/sites/trello.com/board/actions.json",
    content: JSON.stringify({ protocol: "actions.json", version: 1, state_projections: [projection] }),
  }] };
  const config = resolveStateProjectionSemanticConfig(bundle, "https://trello.com/b/board", "board");
  assert.deepEqual(config.policy, projection.semantic.policy);
  assert.equal(config.semantic_namespace, "trello.board");
  assert.equal(resolveStateProjectionSemanticConfig(bundle, "https://trello.com/c/card", "board"), null);
  assert.equal(resolveStateProjectionSemanticConfig(bundle, "https://trello.com/b/board", "missing"), null);
});

class FakeElement {
  constructor({ text = "", attributes = {}, rect = null, children = [] } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.value = text;
    this.checked = false;
    this.ariaLabel = attributes["aria-label"] ?? attributes.ariaLabel ?? "";
    this.attributes = attributes;
    this.rect = rect || { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith("[data-testid='")) {
      const value = selector.slice("[data-testid='".length, -2);
      return this.attributes["data-testid"] === value;
    }
    if (selector === "a") return this.attributes.tag === "a";
    return false;
  }

  querySelectorAll(selector) {
    const hits = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.matches(selector)) hits.push(child);
        visit(child);
      }
    };
    visit(this);
    return hits;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeXPathDocument extends FakeElement {
  constructor(options = {}) {
    super(options);
    this.__xpathHits = new Map();
  }

  setXPathHits(xpath, hits) {
    this.__xpathHits.set(xpath, hits);
  }

  evaluate(xpath) {
    const hits = this.__xpathHits.get(xpath) || [];
    let index = 0;
    return {
      iterateNext() {
        return hits[index++] || null;
      },
    };
  }
}

function trelloFixtureDocument() {
  const cardA = new FakeElement({
    text: "Prepare demo",
    attributes: { "data-testid": "card-name", href: "https://trello.com/c/a" },
    children: [
      new FakeElement({ text: "High", attributes: { "data-testid": "card-label", "aria-label": "High priority" } }),
      new FakeElement({ text: "Jun 12", attributes: { "data-testid": "card-due-date" } }),
      new FakeElement({ text: "1/3", attributes: { "data-testid": "badge-checklist" } }),
    ],
  });
  const cardB = new FakeElement({
    text: "Validate state projections",
    attributes: { "data-testid": "card-name", href: "https://trello.com/c/b" },
  });
  const todo = new FakeElement({
    attributes: { "data-testid": "list-wrapper" },
    children: [
      new FakeElement({ text: "To Do", attributes: { "data-testid": "list-name" } }),
      cardA,
      cardB,
    ],
  });
  const progress = new FakeElement({
    attributes: { "data-testid": "list-wrapper" },
    children: [
      new FakeElement({ text: "In Progress", attributes: { "data-testid": "list-name" } }),
    ],
  });
  return new FakeElement({ children: [todo, progress] });
}

function largeTrelloFixtureDocument(cardCount = 80) {
  const cards = Array.from({ length: cardCount }, (_, index) => new FakeElement({
    text: `Card ${String(index + 1).padStart(3, "0")}: ${"large board task ".repeat(10)}`,
    attributes: {
      "data-testid": "card-name",
      href: `https://trello.com/c/card-${index + 1}`,
    },
    children: [
      new FakeElement({
        text: "Priority: High",
        attributes: { "data-testid": "card-label", "aria-label": "Priority: High" },
      }),
      new FakeElement({
        text: "Agent runnable",
        attributes: { "data-testid": "card-label", "aria-label": "Agent runnable" },
      }),
      new FakeElement({ text: `${index % 9}/9`, attributes: { "data-testid": "badge-checklist" } }),
    ],
  }));
  const next = new FakeElement({
    attributes: { "data-testid": "list-wrapper" },
    children: [
      new FakeElement({ text: "Next", attributes: { "data-testid": "list-name" } }),
      ...cards,
    ],
  });
  return new FakeElement({ children: [next] });
}

const trelloProjection = {
  name: "trello.board",
  description: "Logical board state.",
  scope: {
    url_matches: "https://trello.com/b/*",
  },
  snapshot: {
    version: 1,
    source: "dom",
    extract: [
      {
        id: "lists",
        selector: "[data-testid='list-wrapper']",
        many: true,
        fields: {
          name: {
            selector: "[data-testid='list-name']",
            property: "innerText",
            trim: true,
            required: true,
          },
          cards: {
            selector: "[data-testid='card-name']",
            many: true,
            fields: {
              title: { property: "innerText", trim: true },
              url: { attribute: "href" },
              labels: {
                selector: "[data-testid='card-label']",
                many: true,
                fields: {
                  name: { property: "ariaLabel", trim: true },
                  text: { property: "innerText", trim: true },
                },
              },
              due_date: { selector: "[data-testid='card-due-date']", property: "innerText", trim: true },
              checklist_summary: { selector: "[data-testid='badge-checklist']", property: "innerText", trim: true },
              geometry: { property: "boundingClientRect" },
            },
          },
        },
      },
    ],
    projection: {
      language: "jsonata",
      expression:
        "{% {'board': {'list_count': $count(records.lists), 'lists': $append([], $map(records.lists, function($list) { {'name': $list.name, 'card_count': $count($list.cards), 'cards': $count($list.cards) > 0 ? $append([], $map($list.cards, function($card) { {'title': $card.title, 'url': $card.url, 'labels': $card.labels, 'due_date': $card.due_date, 'checklist_summary': $card.checklist_summary} })) : []} }))}} %}",
    },
    output_schema: {
      type: "object",
      required: ["board"],
      properties: {
        board: {
          type: "object",
          required: ["lists"],
          properties: {
            list_count: { type: "number" },
            lists: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "cards"],
                properties: {
                  name: { type: "string" },
                  card_count: { type: "number" },
                  cards: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["title"],
                      properties: {
                        title: { type: "string" },
                        url: { type: ["string", "null"] },
                        labels: { type: "array" },
                        due_date: { type: ["string", "null"] },
                        checklist_summary: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  summaries: [
    {
      name: "agent_context",
      max_bytes: 4000,
      expression:
        "{% {'lists': $append([], $map(state.board.lists, function($list) { {'name': $list.name, 'cards': $count($list.cards) > 0 ? $append([], $map($list.cards, function($card) { $card.title })) : []} }))} %}",
    },
  ],
};

const bundle = {
  entries: [
    {
      path: "scopes/shared/trello/sites/trello.com/board/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        tools: [],
        state_projections: [trelloProjection],
      }),
    },
  ],
};

test("state projection validation accepts the v1 state_projections shape", () => {
  assert.deepEqual(validateStateProjection(trelloProjection), { ok: true });
});

test("state projections are listed from matching actions.json maps", () => {
  assert.deepEqual(listStateProjectionsFromBundle(bundle, "https://trello.com/b/demo"), [
    {
      name: "trello.board",
      description: "Logical board state.",
      summaries: ["agent_context"],
      summary_definitions: [{
        name: "agent_context",
        description: null,
        max_bytes: 4000,
        input_schema: null,
      }],
    },
  ]);
});

test("state projections are not listed outside their URL scope", () => {
  assert.deepEqual(listStateProjectionsFromBundle(bundle, "https://trello.com/c/card-id/demo-card"), []);
});

test("state projection execution rejects a projection outside its URL scope", async () => {
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/c/card-id/demo-card",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_projection_not_found");
});

test("state projection extracts DOM records, runs JSONata, and validates state", async () => {
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.projection, "trello.board");
  assert.equal(result.diagnostics.schema_valid, true);
  assert.equal(result.diagnostics.selector_counts.lists, 2);
  assert.equal(result.state, undefined);
  assert.equal(result.graph_descriptor.schema_version, 1);
  assert.equal(result.graph_descriptor.snapshot_id, null);
  assert.equal(result.graph_descriptor.active, false);
  assert.equal(result.graph_descriptor.navigation_ready, false);
  assert.equal(result.graph_descriptor.next_step, "snapshot_activation_required");
  assert.equal(result.graph_descriptor.projection, "trello.board");
  assert.deepEqual(result.graph_descriptor.roots, ["n0"]);
  assert.ok(result.graph_descriptor.size.nodes > 1);
  assert.ok(result.graph_descriptor.size.edges > 0);
  assert.equal(result.graph_descriptor.coverage.graph.complete, true);
  assert.equal(result.graph_descriptor.source.map_path, "scopes/shared/trello/sites/trello.com/board/actions.json");
  assert.equal(result.graph_descriptor.source.map_version, null);
  assert.equal(result.graph_descriptor.source.site_host, "trello.com");
  assert.match(result.graph_descriptor.source.content_hash, /^fnv1a64:[0-9a-f]{16}$/);
});

test("public state projection delegates activation and returns only the compact active descriptor", async () => {
  let activation;
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    activateGraph: async (request) => {
      activation = request;
      return {
        snapshot_id: "snapshot-opaque-1",
        roots: request.graph.roots,
        active: true,
        navigation_ready: true,
      };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, undefined);
  assert.equal(result.graph_descriptor.snapshot_id, "snapshot-opaque-1");
  assert.equal(result.graph_descriptor.active, true);
  assert.equal(result.graph_descriptor.navigation_ready, true);
  assert.equal(activation.projection.name, "trello.board");
  assert.equal(activation.provenance.map_path, "scopes/shared/trello/sites/trello.com/board/actions.json");
  assert.match(activation.provenance.content_hash, /^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(activation.graph.coverage.graph.complete, true);
  assert.equal(activation.lexicalIndex, activation.graph.lexical_index);
  assert.match(activation.stateHash, /^djb2:/);
  assert.match(activation.observedAt, /^\d{4}-/);
});

test("state projection extracts records with XPath when CSS selectors are insufficient", async () => {
  const first = new FakeElement({ text: "Alpha project" });
  const second = new FakeElement({ text: "Beta project" });
  const document = new FakeXPathDocument();
  document.setXPathHits("//li[contains(@class, 'project')]", [first, second]);

  const result = await executeStateProjection({
    bundle: {
      entries: [
        {
          path: "scopes/shared/example/sites/example.com/app/actions.json",
          content: JSON.stringify({
            protocol: "actions.json",
            tools: [],
            state_projections: [
              {
                name: "example.projects",
                snapshot: {
                  version: 1,
                  source: "dom",
                  extract: [
                    {
                      id: "projects",
                      xpath: "//li[contains(@class, 'project')]",
                      many: true,
                      fields: {
                        title: { property: "innerText", trim: true },
                      },
                    },
                  ],
                  projection: {
                    language: "jsonata",
                    expression: "{% {'projects': $append([], records.projects.title)} %}",
                  },
                  output_schema: {
                    type: "object",
                    required: ["projects"],
                    properties: {
                      projects: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                },
              },
            ],
          }),
        },
      ],
    },
    pageUrl: "https://example.com/app",
    document,
    projectionName: "example.projects",
    consumer: "internal_compute",
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.state.projects, ["Alpha project", "Beta project"]);
  assert.equal(result.diagnostics.selector_counts.projects, 2);
});

test("state_summary returns compact JSONata summary instead of full state", async () => {
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.summary_name, "agent_context");
  assert.deepEqual(result.summary.lists[0], {
    name: "To Do",
    cards: ["Prepare demo", "Validate state projections"],
  });
  assert.equal(result.state, undefined);
});

test("state projections expose only declared cache namespaces to JSONata", async () => {
  const cachedProjection = structuredClone(trelloProjection);
  cachedProjection.cache = { read_namespaces: ["trello.cards"] };
  cachedProjection.summaries[0].expression = [
    "{% (",
    "$cards := $lookup(cache, 'trello.cards');",
    "$entry := $lookup($cards, 'a');",
    "{'cached': $entry.value.last_touched_at, 'hidden': $exists($lookup(cache, 'other'))}",
    ") %}",
  ].join(" ");
  const cachedBundle = {
    entries: [{
      path: "scopes/shared/trello/sites/trello.com/board/actions.json",
      content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [cachedProjection] }),
    }],
  };
  const result = await executeStateProjection({
    bundle: cachedBundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
    projectionCache: {
      "trello.cards": { a: { value: { last_touched_at: "2026-07-19T12:00:00.000Z" } } },
      other: { secret: { value: "must not cross the declaration boundary" } },
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.summary, { cached: "2026-07-19T12:00:00.000Z", hidden: false });
});

test("state projections emit declared cache writes as bounded data, not side effects", async () => {
  const cachedProjection = structuredClone(trelloProjection);
  cachedProjection.cache = {
    read_namespaces: [],
    writes: [{
      namespace: "trello.cards",
      entries: "{% [{'entity_id': 'a', 'value': {'last_touched_at': '2026-07-19T12:00:00.000Z'}, 'content_hash': 'sha256:a', 'observed_at': '2026-07-19T12:00:00.000Z', 'expires_at': '2026-08-01T00:00:00.000Z', 'provenance': 'trello-visible-activity'}] %}",
    }],
  };
  const cachedBundle = {
    entries: [{
      path: "scopes/shared/trello/sites/trello.com/board/actions.json",
      content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [cachedProjection] }),
    }],
  };
  const result = await executeStateProjection({
    bundle: cachedBundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.cache_updates, [{
    namespace: "trello.cards",
    entries: [{
      entity_id: "a",
      value: { last_touched_at: "2026-07-19T12:00:00.000Z" },
      content_hash: "sha256:a",
      observed_at: "2026-07-19T12:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      provenance: "trello-visible-activity",
    }],
  }]);
});

test("state projection cache declarations reject invalid namespaces and non-array writes", async () => {
  const invalid = structuredClone(trelloProjection);
  invalid.cache = { read_namespaces: ["../other-site"], writes: [] };
  assert.equal(validateStateProjection(invalid).ok, false);

  const wrongOutput = structuredClone(trelloProjection);
  wrongOutput.cache = {
    read_namespaces: [],
    writes: [{ namespace: "trello.cards", entries: "{% {'not': 'an array'} %}" }],
  };
  const result = await executeStateProjection({
    bundle: {
      entries: [{
        path: "scopes/shared/trello/sites/trello.com/board/actions.json",
        content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [wrongOutput] }),
      }],
    },
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_projection_cache_failed");
});

test("summary arguments fail validation before DOM extraction or projection evaluation", async () => {
  const parameterizedProjection = structuredClone(trelloProjection);
  parameterizedProjection.summaries.push({
    name: "list_page",
    max_bytes: 8000,
    input_schema: {
      type: "object",
      required: ["list_name"],
      additionalProperties: false,
      properties: { list_name: { type: "string", minLength: 1 } },
    },
    expression: "{% {'cards': state.board.lists[0].cards} %}",
  });
  parameterizedProjection.snapshot.projection.expression = "{% $error('projection must not run') %}";
  const result = await executeStateProjection({
    bundle: {
      entries: [{
        path: "scopes/shared/trello/sites/trello.com/board/actions.json",
        content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [parameterizedProjection] }),
      }],
    },
    pageUrl: "https://trello.com/b/demo",
    document: null,
    projectionName: "trello.board",
    summaryName: "list_page",
    summaryArguments: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_summary_input_validation_failed");
  assert.deepEqual(result.error.errors, [{ path: "/list_name", message: "Required property is missing." }]);
});

test("large-board summary overflow returns a searchable snapshot instead of a terminal error", async () => {
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: largeTrelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
    activateGraph: async ({ graph }) => ({ snapshot_id: "summary-fallback-snapshot", roots: graph.roots }),
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.summary, undefined);
  assert.equal(result.summary_unavailable.code, "expression_output_too_large");
  assert.equal(result.graph_descriptor.schema_version, 1);
  assert.equal(result.graph_descriptor.snapshot_id, "summary-fallback-snapshot");
  assert.equal(result.graph_descriptor.navigation_ready, true);
  assert.equal(result.graph_descriptor.next_step, undefined);
});

test("parameterized summaries traverse a large board in bounded validated pages", async () => {
  const pagedProjection = structuredClone(trelloProjection);
  pagedProjection.summaries.push({
    name: "list_page",
    max_bytes: 8000,
    input_schema: {
      type: "object",
      required: ["list_name"],
      additionalProperties: false,
      properties: {
        list_name: { type: "string", minLength: 1, maxLength: 120 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    expression: [
      "{% (",
      "$list := state.board.lists[name = $$.input.list_name][0];",
      "$offset := $exists($$.input.offset) ? $$.input.offset : 0;",
      "$limit := $exists($$.input.limit) ? $$.input.limit : 10;",
      "$cards := $list.cards;",
      "$page := $filter($cards, function($card, $index) { $index >= $offset and $index < $offset + $limit });",
      "{'list_name': $list.name, 'offset': $offset, 'limit': $limit, 'total_count': $count($cards),",
      "'has_more': $offset + $limit < $count($cards),",
      "'next_offset': $offset + $limit < $count($cards) ? $offset + $limit : null,",
      "'cards': $count($page) > 0 ? $append([], $map($page, function($card) { {'title': $card.title, 'url': $card.url} })) : []}",
      ") %}",
    ].join(" "),
  });
  const pagedBundle = {
    entries: [{
      path: "scopes/shared/trello/sites/trello.com/board/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        tools: [],
        state_projections: [pagedProjection],
      }),
    }],
  };
  const document = largeTrelloFixtureDocument();
  const observedTitles = [];

  for (let offset = 0; offset < 80; offset += 10) {
    const result = await executeStateProjection({
      bundle: pagedBundle,
      pageUrl: "https://trello.com/b/demo",
      document,
      projectionName: "trello.board",
      summaryName: "list_page",
      summaryArguments: { list_name: "Next", offset, limit: 10 },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.summary.cards.length, 10);
    assert.equal(result.summary.total_count, 80);
    assert.equal(result.summary.offset, offset);
    assert.equal(result.summary.has_more, offset < 70);
    observedTitles.push(...result.summary.cards.map((card) => card.title));
  }

  assert.equal(observedTitles.length, 80);
  assert.equal(new Set(observedTitles).size, 80);

  const invalid = await executeStateProjection({
    bundle: pagedBundle,
    pageUrl: "https://trello.com/b/demo",
    document,
    projectionName: "trello.board",
    summaryName: "list_page",
    summaryArguments: { list_name: "Next", offset: 0, limit: 11 },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "state_summary_input_validation_failed");
});

test("paged summaries remain readable after the full state exceeds its response budget", async () => {
  const pagedProjection = structuredClone(trelloProjection);
  pagedProjection.summaries.push({
    name: "list_page",
    max_bytes: 8000,
    input_schema: {
      type: "object",
      required: ["list_name"],
      additionalProperties: false,
      properties: {
        list_name: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    expression: [
      "{% (",
      "$list := state.board.lists[name = $$.input.list_name][0];",
      "$offset := $exists($$.input.offset) ? $$.input.offset : 0;",
      "$limit := $exists($$.input.limit) ? $$.input.limit : 10;",
      "$cards := $list.cards;",
      "$page := $filter($cards, function($card, $index) { $index >= $offset and $index < $offset + $limit });",
      "{'total_count': $count($cards), 'cards': $append([], $map($page, function($card) { {'title': $card.title} }))}",
      ") %}",
    ].join(" "),
  });
  const pagedBundle = {
    entries: [{
      path: "scopes/shared/trello/sites/trello.com/board/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        tools: [],
        state_projections: [pagedProjection],
      }),
    }],
  };
  const document = largeTrelloFixtureDocument(240);

  const fullState = await executeStateProjection({
    bundle: pagedBundle,
    pageUrl: "https://trello.com/b/demo",
    document,
    projectionName: "trello.board",
  });
  assert.equal(fullState.ok, true, JSON.stringify(fullState.error));
  assert.equal(fullState.state, undefined);
  assert.equal(fullState.graph_descriptor.schema_version, 1);

  const page = await executeStateProjection({
    bundle: pagedBundle,
    pageUrl: "https://trello.com/b/demo",
    document,
    projectionName: "trello.board",
    summaryName: "list_page",
    summaryArguments: { list_name: "Next", offset: 230, limit: 10 },
  });
  assert.equal(page.ok, true, JSON.stringify(page, null, 2));
  assert.equal(page.summary.total_count, 240);
  assert.equal(page.summary.cards.length, 10);
  assert.match(page.summary.cards[0].title, /^Card 231:/);
});

test("caller maxBytes can lower but cannot raise a summary's declared output budget", async () => {
  const lowered = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
    maxBytes: 20,
  });
  assert.equal(lowered.ok, false);
  assert.equal(lowered.error.code, "expression_output_too_large");

  const raised = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: largeTrelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
    maxBytes: 50_000,
  });
  assert.equal(raised.ok, true, JSON.stringify(raised.error));
  assert.equal(raised.summary_unavailable.code, "expression_output_too_large");
  assert.equal(raised.graph_descriptor.schema_version, 1);
});

test("state projection rejects oversized full state with a recoverable error", async () => {
  const result = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    maxBytes: 20,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_payload_too_large");
  assert.deepEqual(result.error.available_summaries, ["agent_context"]);
});

test("public callers cannot raise the full-state cap while internal consumers use the compute budget", async () => {
  const document = largeTrelloFixtureDocument(240);
  const publicResult = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document,
    projectionName: "trello.board",
    maxBytes: 1_000_000,
  });
  assert.equal(publicResult.ok, true, JSON.stringify(publicResult.error));
  assert.equal(publicResult.state, undefined);
  assert.equal(publicResult.graph_descriptor.schema_version, 1);
  assert.equal(publicResult.graph_descriptor.coverage.graph.complete, true);

  const internalResult = await executeStateProjection({
    bundle,
    pageUrl: "https://trello.com/b/demo",
    document,
    projectionName: "trello.board",
    maxBytes: 1_000_000,
    consumer: "internal_compute",
  });
  assert.equal(internalResult.ok, true, JSON.stringify(internalResult.error));
  assert.equal(internalResult.state.board.lists[0].cards.length, 240);
});

test("state diff returns JSON Patch add, remove, and replace operations", () => {
  assert.deepEqual(
    diffStates(
      {
        board: {
          lists: [
            {
              name: "To Do",
              cards: [{ title: "Draft" }, { title: "Review" }],
            },
          ],
        },
      },
      {
        board: {
          lists: [
            {
              name: "In Progress",
              cards: [{ title: "Draft" }, { title: "Ship" }, { title: "Retrospective" }],
            },
          ],
        },
      },
    ),
    [
      { op: "replace", path: "/board/lists/0/name", value: "In Progress" },
      { op: "replace", path: "/board/lists/0/cards/1/title", value: "Ship" },
      { op: "add", path: "/board/lists/0/cards/2", value: { title: "Retrospective" } },
    ],
  );
});

test("semantic deltas explain JSON Patch changes in agent-readable terms", () => {
  assert.deepEqual(
    buildSemanticDeltas([
      { op: "add", path: "/board/lists/0/cards/2", value: { title: "Retrospective" } },
      { op: "replace", path: "/board/lists/0/name", value: "In Progress" },
    ]),
    [
      {
        type: "entity_added",
        entity: {
          kind: "card",
          title: "Retrospective",
        },
        path: "/board/lists/0/cards/2",
        patch: { op: "add", path: "/board/lists/0/cards/2", value: { title: "Retrospective" } },
      },
      {
        type: "field_replaced",
        field: "name",
        path: "/board/lists/0/name",
        value: "In Progress",
        patch: { op: "replace", path: "/board/lists/0/name", value: "In Progress" },
      },
    ],
  );
});

test("state postconditions evaluate JSONata checks against projected state", async () => {
  const result = await verifyStatePostcondition({
    postcondition: {
      verify: {
        language: "jsonata",
        expression: "{% $exists(state.board.lists[name = $$.input.to_list].cards[title = $$.input.card_title]) %}",
      },
      failure_message: "Card was not found in target list.",
    },
    state: {
      board: {
        lists: [
          {
            name: "In Progress",
            cards: [{ title: "Prepare demo" }],
          },
        ],
      },
    },
    input: {
      to_list: "In Progress",
      card_title: "Prepare demo",
    },
  });

  assert.deepEqual(result, { ok: true });
});

test("Trello detail hydration feeds a bounded last_touched_at board digest", async () => {
  const detailProjection = {
    name: "trello.card.activity",
    scope: { url_matches: "https://trello.com/c/*" },
    snapshot: {
      version: 1,
      source: "dom",
      extract: [{
        id: "activity",
        selector: "[data-testid='activity-item']",
        many: true,
        fields: { timestamp: { selector: "time", attribute: "datetime" } },
      }],
      projection: {
        language: "jsonata",
        expression: "{% {'id': $split($split(url, '/c/')[1], '/')[0], 'last_touched_at': records.activity[0].timestamp, 'activity_hash': $join(records.activity.timestamp, '|')} %}",
      },
    },
    cache: {
      read_namespaces: [],
      writes: [{
        namespace: "trello.cards",
        entries: "{% [{'entity_id': state.id, 'value': {'last_touched_at': state.last_touched_at}, 'content_hash': state.activity_hash, 'observed_at': state.last_touched_at, 'expires_at': '2026-08-01T00:00:00.000Z', 'provenance': 'trello-visible-activity'}] %}",
      }],
    },
  };
  const activityItem = new FakeElement({
    attributes: { "data-testid": "activity-item" },
    children: [new FakeElement({ attributes: { tag: "time", datetime: "2026-07-19T12:00:00.000Z" } })],
  });
  activityItem.children[0].matches = (selector) => selector === "time";
  const detail = await executeStateProjection({
    bundle: { entries: [{
      path: "scopes/public/sites/trello.com/card/actions.json",
      content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [detailProjection] }),
    }] },
    pageUrl: "https://trello.com/c/a/demo",
    document: new FakeElement({ children: [activityItem] }),
    projectionName: "trello.card.activity",
  });
  assert.equal(detail.ok, true, JSON.stringify(detail, null, 2));
  const hydratedEntry = detail.cache_updates[0].entries[0];

  const boardProjection = structuredClone(trelloProjection);
  boardProjection.cache = { read_namespaces: ["trello.cards"] };
  boardProjection.summaries[0].expression = [
    "{% (",
    "$entry := $lookup($lookup(cache, 'trello.cards'), 'a');",
    "{'cards': [{'id': 'a', 'last_touched_at': $entry.value.last_touched_at, 'last_touched_freshness': $entry.freshness}]}",
    ") %}",
  ].join(" ");
  const boardResult = await executeStateProjection({
    bundle: { entries: [{
      path: "scopes/public/sites/trello.com/board/actions.json",
      content: JSON.stringify({ protocol: "actions.json", tools: [], state_projections: [boardProjection] }),
    }] },
    pageUrl: "https://trello.com/b/demo",
    document: trelloFixtureDocument(),
    projectionName: "trello.board",
    summaryName: "agent_context",
    projectionCache: {
      "trello.cards": {
        a: { value: hydratedEntry.value, freshness: "known" },
      },
    },
  });
  assert.deepEqual(boardResult.summary, {
    cards: [{ id: "a", last_touched_at: "2026-07-19T12:00:00.000Z", last_touched_freshness: "known" }],
  });
});
