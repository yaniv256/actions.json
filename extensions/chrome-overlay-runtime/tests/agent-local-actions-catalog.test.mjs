import assert from "node:assert/strict";
import test from "node:test";
import {
  listExecutableRuntimeActionNames,
  listSiteActionsBoundedFromBundle,
  listSiteStorageFilesFromBundle,
  listSiteActionsFromBundle,
  resolveSiteActionFromBundle,
  readSiteStorageFileFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "../src/agent/local-actions-catalog.mjs";
import { validateWorkflow } from "../src/agent/workflow-actions.mjs";

test("runtime workflow allowlist includes executable tools and supported dictionary primitives", () => {
  const knownPrimitives = listExecutableRuntimeActionNames({
    tools: [
      { name: "browser.extract_elements" },
      { name: "pointer.click" },
    ],
    primitive_dictionary: {
      primitives: [
        { name: "pointer.click", support: "supported" },
        { name: "locator.element_info" },
        { name: "legacy.unsupported", support: "unsupported" },
      ],
    },
  });
  assert.deepEqual(
    knownPrimitives,
    ["browser.extract_elements", "pointer.click", "locator.element_info"],
  );
  assert.deepEqual(
    validateWorkflow(
      {
        version: 1,
        expression_language: "jsonata",
        steps: [
          {
            id: "readRows",
            primitive: "browser.extract_elements",
            args: { item_selector: "[role='checkbox']", fields: [{ name: "checked", attribute: "aria-checked" }] },
          },
        ],
      },
      { knownPrimitives },
    ),
    { ok: true },
  );
});

const bundle = {
  protocol: "actions.json.storage.bundle",
  entries: [
    {
      path: "scopes/shared/acme/sites/acme.example/home/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        x_actions: {
          files: [
            {
              id: "acme-skill",
              path: "SKILL.md",
              kind: "skill",
              description: "How to host the Acme website.",
              read_when: "Read before acting as the Acme website host.",
            },
          ],
        },
        requires: {
          primitive_dictionary: {
            blocked_primitives: ["browser.run_javascript", "debug.run_javascript"],
          },
        },
        state_projections: [
          {
            name: "acme.cards",
            snapshot: {
              version: 1,
              source: "dom",
              extract: [],
              projection: {
                language: "jsonata",
                expression: "{% {'cards': []} %}",
              },
            },
            postconditions: {
              "acme.card.by_title.open": {
                projection: "acme.cards",
                verify: {
                  language: "jsonata",
                  expression: "{% true %}",
                },
              },
            },
          },
        ],
        tools: [
          {
            name: "acme.site.map",
            description: "Return the site map.",
            input_schema: { type: "object" },
            x_actions: {
              static_output: { ok: true, site: "acme.example" },
            },
          },
          {
            name: "acme.sections.list",
            description: "List visible sections.",
            input_schema: { type: "object" },
            x_actions: {
              handler: "dom.list_sections",
              binding: {
                target_url_contains: "acme.example",
                arguments: { include_hidden: false },
              },
            },
          },
          {
            name: "acme.card.by_title.candidates",
            description: "Resolve card candidates by title.",
            input_schema: { type: "object" },
            x_actions: {
              handler: "locator.element_info",
              binding: {
                target_url_contains: "acme.example",
                arguments: {
                  locator: {
                    selector: "[data-testid='card-name']",
                  },
                },
              },
            },
          },
          {
            name: "acme.card.by_title.open",
            description: "Resolve a card by title and click its center.",
            input_schema: { type: "object" },
            workflow: {
              version: 1,
              expression_language: "jsonata",
              steps: [
                {
                  id: "findCard",
                  primitive: "locator.element_info",
                  args: {
                    locator: {
                      selector: "[data-testid='card-name']",
                      text_contains: "{% input.title %}",
                    },
                  },
                },
                {
                  id: "clickCard",
                  primitive: "pointer.click",
                  args: {
                    x: "{% steps.findCard.output.clickable_center.x %}",
                    y: "{% steps.findCard.output.clickable_center.y %}",
                  },
                },
              ],
            },
          },
        ],
      }),
    },
    {
      path: "scopes/shared/acme/sites/acme.example/home/SKILL.md",
      content: [
        "---",
        "name: acme-host",
        "description: Host visitors through Juan's AI engineering methodology.",
        "version: 0.1.0",
        "read_when: Read before introducing the site or answering questions about the methodology.",
        "---",
        "",
        "# Acme Host Skill",
        "",
        "Ask what engineering friction brought the visitor here.",
      ].join("\n"),
    },
  ],
};

test("local actions catalog lists current-site actions from a shared storage bundle", () => {
  const actions = listSiteActionsFromBundle(bundle, "https://acme.example/");
  assert.deepEqual(
    actions.map((action) => action.name),
    [
      "acme.site.map",
      "acme.sections.list",
      "acme.card.by_title.candidates",
      "acme.card.by_title.open",
    ],
  );
  assert.equal(actions[1].target_url_contains, "acme.example");
});

test("local actions catalog ignores pipeline proof-package map copies", () => {
  const bundleWithProof = structuredClone(bundle);
  bundleWithProof.entries.push({
    path: "scopes/shared/acme/sites/acme.example/home/proof/validated-2026-07-14/actions.json",
    content: bundle.entries[0].content,
  });

  const actions = listSiteActionsFromBundle(bundleWithProof, "https://acme.example/");

  assert.deepEqual(
    actions.map((action) => action.name),
    [
      "acme.site.map",
      "acme.sections.list",
      "acme.card.by_title.candidates",
      "acme.card.by_title.open",
    ],
  );
});

test("bounded local actions catalog filters, paginates, caps output, and binds cursors to provenance", () => {
  const many = structuredClone(bundle);
  const map = JSON.parse(many.entries[0].content);
  map.tools = Array.from({ length: 12 }, (_, index) => ({
    name: `acme.card.${String(index).padStart(2, "0")}`,
    description: index === 11 ? "Find the invoice needle." : `Open card ${index}.`,
    input_schema: { type: "object", properties: { title: { type: "string" } } },
  }));
  many.entries[0].content = JSON.stringify(map);

  const first = listSiteActionsBoundedFromBundle(many, "https://acme.example/", {
    query: "acme.card",
    max_bytes: 2_500,
  });
  assert.equal(first.ok, true);
  assert.equal(first.value.actions.length, 5);
  assert.equal(first.value.page.page_size, 5);
  assert.equal(first.value.page.has_more, true);
  assert.equal(typeof first.value.page.continuation, "string");
  assert.match(first.value.provenance.catalog_hash, /^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(first.value.actions[0].source.map_path, many.entries[0].path);
  assert.match(first.value.actions[0].source.content_hash, /^fnv1a64:[0-9a-f]{16}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2_500);

  const second = listSiteActionsBoundedFromBundle(many, "https://acme.example/", {
    query: "acme.card",
    continuation: first.value.page.continuation,
    max_bytes: 2_500,
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second.value.actions.map(({ name }) => name), [
    "acme.card.05",
    "acme.card.06",
    "acme.card.07",
    "acme.card.08",
    "acme.card.09",
  ]);

  const needle = listSiteActionsBoundedFromBundle(many, "https://acme.example/", {
    query: "invoice needle",
    max_bytes: 2_500,
  });
  assert.deepEqual(needle.value.actions.map(({ name }) => name), ["acme.card.11"]);

  const changed = structuredClone(many);
  changed.entries[0].content = `${changed.entries[0].content}\n`;
  const stale = listSiteActionsBoundedFromBundle(changed, "https://acme.example/", {
    query: "acme.card",
    continuation: first.value.page.continuation,
    max_bytes: 2_500,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "catalog_continuation_invalid");
});

test("bounded local actions catalog preserves legacy list behavior and enforces requested page limit", () => {
  const legacy = listSiteActionsFromBundle(bundle, "https://acme.example/");
  const bounded = listSiteActionsBoundedFromBundle(bundle, "https://acme.example/", {
    page_size: 99,
    max_bytes: 4_000,
  });

  assert.equal(bounded.ok, true);
  assert.equal(bounded.value.page.page_size, 5);
  assert.deepEqual(
    bounded.value.actions.map(({ name }) => name),
    legacy.map(({ name }) => name).sort(),
  );
  assert.equal(legacy[0].source, undefined);
});

test("local actions catalog resolves workflow-backed stored actions", () => {
  const result = resolveSiteActionFromBundle(bundle, "https://acme.example/", {
    action: "acme.card.by_title.open",
    arguments: { title: "Demo card" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflow.action_name, "acme.card.by_title.open");
  assert.deepEqual(result.workflow.input, { title: "Demo card" });
  assert.equal(result.workflow.definition.expression_language, "jsonata");
  assert.equal(result.workflow.definition.steps[1].primitive, "pointer.click");
  assert.deepEqual(result.workflow.postcondition, {
    projection_name: "acme.cards",
    definition: {
      projection: "acme.cards",
      verify: {
        language: "jsonata",
        expression: "{% true %}",
      },
    },
  });
});

test("local actions catalog recursively merges caller arguments into primitive bindings", () => {
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://acme.example/", {
      action: "acme.card.by_title.candidates",
      arguments: {
        locator: {
          text_contains: "Get Trello control to be demo ready",
        },
      },
    }),
    {
      ok: true,
      resolved: {
        name: "locator.element_info",
        arguments: {
          locator: {
            selector: "[data-testid='card-name']",
            text_contains: "Get Trello control to be demo ready",
          },
        },
        target_url_contains: "acme.example",
      },
    },
  );
});

test("local actions catalog preserves declarative cache invalidation policy", () => {
  const withCache = structuredClone(bundle);
  const map = JSON.parse(withCache.entries[0].content);
  map.tools.find((tool) => tool.name === "acme.sections.list").cache = {
    invalidations: [{ namespace: "acme.sections", entity_id_argument: "section_id" }],
  };
  withCache.entries[0].content = JSON.stringify(map);

  const result = resolveSiteActionFromBundle(withCache, "https://acme.example/", {
    action: "acme.sections.list",
    arguments: { section_id: "section-1" },
  });
  assert.deepEqual(result.cache, {
    invalidations: [{ namespace: "acme.sections", entity_id_argument: "section_id" }],
  });
});

test("local actions catalog lists declared storage files and skill front matter", () => {
  const catalog = listSiteStorageFilesFromBundle(bundle, "https://acme.example/");

  assert.deepEqual(catalog.files, [
    {
      id: "acme-skill",
      path: "scopes/shared/acme/sites/acme.example/home/SKILL.md",
      relative_path: "SKILL.md",
      kind: "skill",
      title: null,
      description: "How to host the Acme website.",
      read_when: "Read before acting as the Acme website host.",
      size_bytes: bundle.entries[1].content.length,
    },
  ]);
  assert.deepEqual(catalog.skills, [
    {
      id: "acme-skill",
      path: "scopes/shared/acme/sites/acme.example/home/SKILL.md",
      relative_path: "SKILL.md",
      kind: "skill",
      description: "How to host the Acme website.",
      read_when: "Read before acting as the Acme website host.",
      front_matter: {
        name: "acme-host",
        description: "Host visitors through Juan's AI engineering methodology.",
        version: "0.1.0",
        read_when: "Read before introducing the site or answering questions about the methodology.",
      },
    },
  ]);
});

test("local actions catalog reads declared text files by id or path", () => {
  const byId = readSiteStorageFileFromBundle(bundle, "https://acme.example/", {
    id: "acme-skill",
  });
  assert.equal(byId.ok, true);
  assert.equal(byId.value.kind, "skill");
  assert.equal(byId.value.path, "scopes/shared/acme/sites/acme.example/home/SKILL.md");
  assert.equal(byId.value.front_matter.name, "acme-host");
  assert.match(byId.value.text, /Acme Host Skill/);

  const byPath = readSiteStorageFileFromBundle(bundle, "https://acme.example/", {
    path: "scopes/shared/acme/sites/acme.example/home/SKILL.md",
  });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.value.path, byId.value.path);
});

test("local actions catalog reads site blocked primitive declarations", () => {
  assert.deepEqual(
    siteBlockedPrimitiveNamesFromBundle(bundle, "https://acme.example/"),
    ["browser.run_javascript", "debug.run_javascript"],
  );
  assert.deepEqual(siteBlockedPrimitiveNamesFromBundle(bundle, "https://example.com/"), []);
});

test("local actions catalog resolves static and primitive-backed stored actions", () => {
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://acme.example/", {
      action: "acme.site.map",
      arguments: {},
    }),
    {
      ok: true,
      static_output: { ok: true, site: "acme.example" },
    },
  );
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://acme.example/", {
      action: "acme.sections.list",
      arguments: { max_items: 10 },
    }),
    {
      ok: true,
      resolved: {
        name: "dom.list_sections",
        arguments: { include_hidden: false, max_items: 10 },
        target_url_contains: "acme.example",
      },
    },
  );
});
