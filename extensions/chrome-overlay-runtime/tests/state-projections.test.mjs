import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticDeltas,
  diffStates,
  executeStateProjection,
  listStateProjectionsFromBundle,
  verifyStatePostcondition,
  validateStateProjection,
} from "../src/agent/state-projections.mjs";

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
  assert.deepEqual(result.state.board.lists.map((list) => list.name), ["To Do", "In Progress"]);
  assert.deepEqual(result.state.board.lists[0].cards.map((card) => card.title), [
    "Prepare demo",
    "Validate state projections",
  ]);
  assert.deepEqual(result.state.board.lists[0].cards[0].labels, [{ name: "High priority", text: "High" }]);
  assert.equal(result.state.board.lists[0].cards[0].due_date, "Jun 12");
  assert.equal(result.state.board.lists[0].cards[0].checklist_summary, "1/3");
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
